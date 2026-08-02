// 银行对账单 CSV 解析。加拿大各行导出格式各不相同，这里只认三件事：
// 日期、摘要、金额 —— 列名同义词表尽量覆盖常见银行（RBC/TD/BMO/Scotiabank/CIBC）。
// 解析失败逐行报错，不因为一行坏数据丢掉整个文件（会计师的对账单常有页脚行）。

export type ParsedTxn = {
  date: Date;
  description: string;
  amount: number; // 统一为正数支出金额（见 normalizeAmount）
};

export type RowError = { line: number; reason: string; raw: string };

export type ParseResult = {
  rows: ParsedTxn[];
  errors: RowError[];
  detected: { date: string; description: string; amount: string; debit?: string; credit?: string };
};

const DATE_KEYS = ["date", "transaction date", "posting date", "日期", "交易日期", "date de transaction"];
const DESC_KEYS = ["description", "details", "narrative", "memo", "transaction details", "摘要", "描述", "description 1"];
const AMOUNT_KEYS = ["amount", "transaction amount", "金额", "montant"];
// 有些银行分借贷两列（TD/CIBC 常见）
const DEBIT_KEYS = ["debit", "withdrawal", "withdrawals", "debits", "支出", "借方"];
const CREDIT_KEYS = ["credit", "deposit", "deposits", "credits", "收入", "贷方"];

// RFC4180 风格解析：支持引号包裹、引号内逗号、"" 转义。
export function parseCsvLines(text: string): string[][] {
  const clean = text.replace(/^﻿/, ""); // 去 BOM，Excel 导出常带
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && clean[i + 1] === "\n") i++;
      row.push(field);
      // 全空行直接丢（对账单末尾常有）
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

function findColumn(header: string[], keys: string[]): number {
  const norm = header.map((h) => h.trim().toLowerCase());
  for (const k of keys) {
    const i = norm.indexOf(k);
    if (i >= 0) return i;
  }
  // 退一步：包含匹配（"Transaction Date (MM/DD)" 这类）
  for (const k of keys) {
    const i = norm.findIndex((h) => h.includes(k));
    if (i >= 0) return i;
  }
  return -1;
}

// 加拿大银行常见 yyyy-mm-dd / mm/dd/yyyy / dd-mmm-yyyy
export function parseDate(raw: string): Date | null {
  const s = raw.trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) return mk(+iso[1], +iso[2], +iso[3]);
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (slash) return mk(+slash[3], +slash[1], +slash[2]); // 北美惯例 mm/dd/yyyy
  const dmy = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if (dmy) {
    const m = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
      dmy[2].toLowerCase(),
    );
    if (m >= 0) return mk(+dmy[3], m + 1, +dmy[1]);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mk(y: number, m: number, d: number): Date | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}

// "$1,234.56" / "(123.45)" / "-123.45" → 数字。括号与负号都表示支出方向。
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(/[$\s,]/g, "");
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function parseBankCsv(text: string): ParseResult {
  const lines = parseCsvLines(text);
  if (!lines.length) {
    return { rows: [], errors: [{ line: 0, reason: "文件为空", raw: "" }], detected: { date: "", description: "", amount: "" } };
  }

  const header = lines[0];
  const iDate = findColumn(header, DATE_KEYS);
  const iDesc = findColumn(header, DESC_KEYS);
  const iAmount = findColumn(header, AMOUNT_KEYS);
  const iDebit = findColumn(header, DEBIT_KEYS);
  const iCredit = findColumn(header, CREDIT_KEYS);

  const missing: string[] = [];
  if (iDate < 0) missing.push("日期");
  if (iDesc < 0) missing.push("摘要");
  if (iAmount < 0 && iDebit < 0) missing.push("金额（或支出列）");
  if (missing.length) {
    return {
      rows: [],
      errors: [{ line: 1, reason: `表头缺少：${missing.join("、")}。实际表头：${header.join(" | ")}`, raw: header.join(",") }],
      detected: { date: header[iDate] ?? "", description: header[iDesc] ?? "", amount: header[iAmount] ?? "" },
    };
  }

  const rows: ParsedTxn[] = [];
  const errors: RowError[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i];
    const raw = cols.join(",");
    const date = parseDate(cols[iDate] ?? "");
    if (!date) {
      errors.push({ line: i + 1, reason: `日期无法解析：「${cols[iDate] ?? ""}」`, raw });
      continue;
    }
    const description = (cols[iDesc] ?? "").trim();
    if (!description) {
      errors.push({ line: i + 1, reason: "摘要为空", raw });
      continue;
    }

    // 单金额列：负数或括号 = 支出；分列时取借方
    let amount: number | null = null;
    if (iAmount >= 0) {
      const v = parseAmount(cols[iAmount] ?? "");
      if (v == null) {
        errors.push({ line: i + 1, reason: `金额无法解析：「${cols[iAmount] ?? ""}」`, raw });
        continue;
      }
      amount = v;
    } else {
      const debit = parseAmount(cols[iDebit] ?? "");
      const credit = iCredit >= 0 ? parseAmount(cols[iCredit] ?? "") : null;
      if (debit != null && debit !== 0) amount = -Math.abs(debit);
      else if (credit != null && credit !== 0) amount = Math.abs(credit);
      else {
        errors.push({ line: i + 1, reason: "借贷两列都为空", raw });
        continue;
      }
    }

    // 只收支出：对账要找的是「花了钱却没有票」。收入行跳过但不算错误。
    if (amount >= 0) continue;

    rows.push({ date, description, amount: Math.abs(amount) });
  }

  return {
    rows,
    errors,
    detected: {
      date: header[iDate] ?? "",
      description: header[iDesc] ?? "",
      amount: iAmount >= 0 ? (header[iAmount] ?? "") : `${header[iDebit] ?? ""}${iCredit >= 0 ? ` / ${header[iCredit]}` : ""}`,
    },
  };
}

// 同一笔流水的指纹：同客户下 日期+摘要+金额 相同即视为重复导入。
export function txnFingerprint(clientId: string, t: ParsedTxn): string {
  return `${clientId}|${t.date.toISOString().slice(0, 10)}|${t.description.trim().toUpperCase()}|${t.amount.toFixed(2)}`;
}
