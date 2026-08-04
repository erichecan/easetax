"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DevAccount } from "@/lib/dev-login";

export function LoginForm({ devAccounts = [] }: { devAccounts?: DevAccount[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("demo@easetax.ca");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function login(mail: string, pass: string) {
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: mail, password: pass }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `登录失败 (${res.status})`);
        return;
      }
      router.replace("/clients");
      router.refresh();
    } catch {
      setError("网络错误");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {devAccounts.length > 0 && (
        <div className="mt-5 rounded-xl border border-dashed border-gold-100 bg-gold-50/60 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-gold-700">开发 / 演示环境</div>
          <div className="mt-2 space-y-1.5">
            {devAccounts.map((a) => (
              <button
                key={a.email}
                onClick={() => login(a.email, a.password)}
                disabled={loading}
                className="w-full rounded-lg bg-gold-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-gold-700 disabled:opacity-50"
              >
                {loading ? "登录中…" : `一键登录 · ${a.label}`}
              </button>
            ))}
          </div>
          <div className="mt-2 text-[11px] leading-snug text-gold-700/80">
            仅本地开发与演示可用，生产环境不会出现此入口。
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          login(email, password);
        }}
        className="mt-4 space-y-3"
      >
        <div>
          <label className="block text-xs font-medium text-muted">邮箱</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink-900 outline-none focus:border-ink-600"
            autoComplete="username"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted">密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm text-ink-900 outline-none focus:border-ink-600"
            autoComplete="current-password"
          />
        </div>
        {error && <div className="rounded-lg bg-conf-low-bg px-3 py-2 text-xs text-conf-low">{error}</div>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-lg bg-ink-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-ink-800 disabled:opacity-50"
        >
          {loading ? "登录中…" : "登录"}
        </button>
      </form>
    </>
  );
}
