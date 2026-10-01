// wtangent git-sync:两级 git 同步(pi git-checkpoint / auto-commit-on-exit 改造版)。
// - 启动:pull(origin 有则拉,无则优雅跳过)
// - 每轮开始:turn_start 时对上一轮未提交变更做快照提交(真回退的 history 地基)
// - 每轮结束:turn_end 有变更 → 提交 + push(有 origin 时)
// - 通用性:无 git / 无 origin / 非仓库全链优雅降级,零报错干扰

import type { ExtensionAPI } from "@tangent-ai/tangent-coding-agent";

export default function (tangent: ExtensionAPI): void {
	let syncing = false;

	async function git(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
		const r = await tangent.exec("git", args, { cwd });
		return { code: r.code, out: (r.stdout ?? "") + (r.stderr ?? "") };
	}

	async function hasChanges(cwd: string): Promise<boolean> {
		const { code, out } = await git(cwd, ["status", "--porcelain"]);
		return code === 0 && out.trim().length > 0;
	}

	async function commitSnapshot(cwd: string, label: string): Promise<boolean> {
		if (!(await hasChanges(cwd))) return false;
		await git(cwd, ["add", "-A"]);
		const { code } = await git(cwd, ["commit", "-m", label]);
		return code === 0;
	}

	// —— 启动:pull(有 origin 时);顺带确保是 git 仓 ——
	tangent.on("session_start" as any, async (_e: any, ctx: any) => {
		const cwd = ctx.cwd;
		try {
			const { code } = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
			if (code !== 0) return;   // 非 git 仓:零干扰
			const remotes = await git(cwd, ["remote"]);
			if (!remotes.out.trim()) return;   // 无 origin:纯本地模式
			await git(cwd, ["pull", "--rebase", "--autostash"]);
		} catch { /* 网络失败不阻塞会话 */ }
	});

	// —— 每轮开始:把上一轮遗留变更先快照提交(回退粒度 = 轮) ——
	tangent.on("turn_start" as any, async (_e: any, ctx: any) => {
		const cwd = ctx.cwd;
		try {
			await commitSnapshot(cwd, "tangent: 轮前快照(上一轮遗留变更)");
		} catch { /* 非仓库等,忽略 */ }
	});

	// —— 每轮结束:提交本轮变更 + push ——
	tangent.on("turn_end" as any, async (_e: any, ctx: any) => {
		if (syncing) return;
		syncing = true;
		try {
			const cwd = ctx.cwd;
			const committed = await commitSnapshot(cwd, `tangent: 轮末快照 ${new Date().toISOString().slice(0, 16)}`);
			if (!committed) return;   // 无变更
			const remotes = await git(cwd, ["remote"]);
			if (!remotes.out.trim()) return;
			const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
			await git(cwd, ["push", "origin", branch]);
			if (ctx.hasUI) ctx.ui.setStatus("wtangent-git", "已同步");
		} catch { /* push 失败:下轮 turn_start 快照兜底,不阻塞 */ }
		finally {
			syncing = false;
		}
	});
}
