/**
 * Test-Message-retention smoke.
 *
 * Runs a standalone TestController against a synthetic TestItem, calls
 * `run.failed(testItem, [msg])` then transitions to `run.passed(testItem)`,
 * and pauses so the human can observe and screenshot the Test Results panel
 * to confirm whether the failure TestMessage survives the passed transition.
 *
 * Invoke via the Command Palette: "QA Debug: Smoke — TestMessage Retention".
 *
 * Outcome verification:
 *  - Failure message STAYS visible → the mapping holds; mark-passed renders
 *    the sticky failure message + the new marked-passed message overlay as
 *    designed.
 *  - Failure message DISAPPEARS → file an ARCH §3.6 relaxation CR; fall back
 *    to description+appendOutput-only marked-passed signalling.
 */

import * as vscode from 'vscode';

const SMOKE_CONTROLLER_ID = 'qa-debug-smoke-test-message-retention';
const SMOKE_LABEL = 'QA Debug Smoke — TestMessage Retention';
const SMOKE_FILE_LABEL = 'smoke-suite.spec.js';

export async function smokeTestMessageRetention(): Promise<void> {
  const controller = vscode.tests.createTestController(SMOKE_CONTROLLER_ID, SMOKE_LABEL);
  const disposeController = (): void => controller.dispose();
  try {
    const fakeUri = vscode.Uri.parse(`untitled:${SMOKE_FILE_LABEL}`);
    const fileItem = controller.createTestItem('smoke-file', SMOKE_FILE_LABEL, fakeUri);
    controller.items.add(fileItem);
    const testItem = controller.createTestItem('smoke-test', 'should reveal whether TestMessage survives passed transition', fakeUri);
    fileItem.children.add(testItem);

    const request = new vscode.TestRunRequest([testItem]);
    const run = controller.createTestRun(request, 'TestMessage retention smoke');

    run.started(testItem);

    // Build a memorable failure TestMessage.
    const md = new vscode.MarkdownString(
      `**This is the failure TestMessage** — created at \`run.failed(...)\` time.\n\n` +
        `If you can still read this *after* the test row turns green, the ` +
        `mapping holds: marked-passed will visually distinguish from a plain pass. ` +
        `If this message disappears when the row goes green, the mapping needs the ` +
        `fallback (ARCH §3.6 relaxation CR).`,
    );
    md.isTrusted = false;
    const failureMsg = new vscode.TestMessage(md);
    failureMsg.contextValue = 'qaDebugSmoke';
    run.failed(testItem, [failureMsg]);

    // Pause so the human can observe the failed state + screenshot it.
    const proceed = await vscode.window.showInformationMessage(
      'TestMessage Retention Smoke: test is now in FAILED state with a TestMessage attached. ' +
        'Open the Test Explorer panel to verify the message is visible. ' +
        'Click "Transition to passed" when ready.',
      { modal: false },
      'Transition to passed',
      'Cancel',
    );

    if (proceed !== 'Transition to passed') {
      run.end();
      void vscode.window.showInformationMessage('Smoke aborted; run.end() called without transition.');
      return;
    }

    // The mapping calls run.failed THEN run.passed without an end() in
    // between. We do the same here.
    run.passed(testItem, 1234);

    await vscode.window.showInformationMessage(
      'TestMessage Retention Smoke: test transitioned to PASSED. ' +
        'Verify in Test Explorer whether the original failure TestMessage is still visible. ' +
        'Click into the test row to open the Test Results panel. SCREENSHOT THIS STATE. ' +
        'Click OK to end the run.',
      { modal: false },
      'OK',
    );

    run.end();

    void vscode.window.showInformationMessage(
      'Smoke complete. Outcome: ' +
        'If the failure TestMessage survived → the mapping holds, proceed to F5 fixture smoke. ' +
        'If it disappeared → file an ARCH §3.6 relaxation CR before the next PR opens.',
    );
  } finally {
    disposeController();
  }
}
