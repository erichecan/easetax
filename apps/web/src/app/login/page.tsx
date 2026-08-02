import { LoginForm } from "@/components/login-form";
import { devLoginAccounts } from "@/lib/dev-login";

export default function LoginPage() {
  // 在 server component 里取：生产环境返回空数组，凭据不会进前端包
  const devAccounts = devLoginAccounts();

  return (
    <div className="grid min-h-screen place-items-center bg-paper px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="grid size-10 place-items-center rounded-lg bg-ink-700 font-display text-xl font-bold text-white">
            易
          </div>
          <div className="leading-tight">
            <div className="font-display text-lg font-bold text-ink-900">易账 Easetax</div>
            <div className="text-[11px] tracking-wide text-faint">AP 工作台</div>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-[0_2px_24px_-8px_rgba(31,77,63,0.12)]">
          <h1 className="font-display text-xl font-bold text-ink-900">登录</h1>
          <p className="mt-1 text-sm text-muted">会计师工作台</p>
          <LoginForm devAccounts={devAccounts} />
        </div>
      </div>
    </div>
  );
}
