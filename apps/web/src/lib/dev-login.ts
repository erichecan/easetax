// 开发/演示用的一键登录凭据。**只在非生产环境提供**：
// 生产下 devLoginAccounts() 返回空数组，按钮不渲染，凭据也不会进前端包
// （这个函数只在 server component 里调用，结果作为 props 下发）。
export type DevAccount = {
  label: string;
  email: string;
  password: string;
};

export function devLoginEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  // 逃生开关：本地也想关掉演示登录时设 DISABLE_DEV_LOGIN=1
  return process.env.DISABLE_DEV_LOGIN !== "1";
}

export function devLoginAccounts(): DevAccount[] {
  if (!devLoginEnabled()) return [];
  return [
    {
      label: "会计师（演示账号）",
      email: process.env.DEV_LOGIN_EMAIL ?? "demo@easetax.ca",
      password: process.env.DEV_LOGIN_PASSWORD ?? "easetax-demo",
    },
  ];
}
