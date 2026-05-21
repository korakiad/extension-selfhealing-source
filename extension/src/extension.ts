import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel('QA Debug Companion');
  context.subscriptions.push(channel);
  channel.appendLine(`[activate] qa-debug-companion ${context.extension.packageJSON.version} ready`);

  for (const id of ['qa-debug.runFixture', 'qa-debug.retry', 'qa-debug.markPassed', 'qa-debug.giveUp']) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, () => {
        channel.appendLine(`[command] ${id} invoked — no-op in S1 scaffold`);
        void vscode.window.showInformationMessage(`${id} (S1 scaffold; wired in S4)`);
      }),
    );
  }
}

export function deactivate(): void {}
