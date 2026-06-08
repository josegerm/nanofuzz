import * as vscode from 'vscode';
import * as path from 'path';
import { DiffLlmEngine } from './DiffLlmEngine';
import { FunctionMatch } from '../ui/FuzzPanel';
export const commands = {
  diffLlmPrompt: {
    name: 'nanofuzz.diffLlmPrompt',
    fn: handleDiffLlmPromptCommand
  },
  diffLlmFunction: {
    name: 'nanofuzz.diffLlmFunction',
    fn: handleDiffLlmFunctionCommand
  }
};
function getWorkspaceRoot(): string {
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0].uri.fsPath;
  }
  throw new Error('Please open a workspace folder to use specification discovery.');
}
/**
 * Greenfield: Run Specification Discovery from a Prompt
 */
async function handleDiffLlmPromptCommand(): Promise<void> {
  const userPrompt = await vscode.window.showInputBox({
    prompt: 'Enter a natural language prompt describing the function to design',
    placeHolder: "e.g., 'write a function rotate(rect) that rotates a Rectangle 90deg clockwise'",
    ignoreFocusOut: true
  });
  if (!userPrompt) {
    return; // User cancelled
  }
  const workspaceRoot = getWorkspaceRoot();
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'NaNofuzz: Specification Discovery',
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: 'Initializing Gemini spec analyzer...' });
      const engine = new DiffLlmEngine();
      progress.report({ message: 'Analyzing prompt and generating Fast-Check arbitraries...' });
      
      progress.report({ message: 'Generating alternative AI implementations...' });
      progress.report({ message: 'Executing 10,000 differential fuzzing runs in V8 sandbox...' });
      const reportPath = await engine.runFromPrompt(userPrompt, workspaceRoot);
      progress.report({ message: 'Opening ambiguity matrix report...' });
      const fileUri = vscode.Uri.file(reportPath);
      await vscode.env.openExternal(fileUri);
      vscode.window.showInformationMessage(
        `Specification Discovery Completed! Report saved to: ${path.basename(reportPath)}`
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Specification Discovery Failed: ${msg}`);
    }
  });
}
/**
 * Brownfield: Run Ambiguity Analysis on an Existing Function
 */
async function handleDiffLlmFunctionCommand(match?: FunctionMatch): Promise<void> {
  // If triggered without a match (e.g. from command palette directly), show warning
  if (!match) {
    vscode.window.showWarningMessage('Please use the "Discover Ambiguities" button in the editor above a function.');
    return;
  }
  const { document, ref } = match;
  // Save the document first if it is dirty
  if (document.isDirty) {
    await document.save();
  }
  const fullText = document.getText();
  const fnSource = fullText.substring(ref.startOffset, ref.endOffset);
  const fnName = ref.name;
  const workspaceRoot = getWorkspaceRoot();
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `NaNofuzz: Analyzing ${fnName}`,
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: `Extracting ${fnName} structure...` });
      const engine = new DiffLlmEngine();
      progress.report({ message: 'Analyzing specification with Gemini...' });
      
      progress.report({ message: 'Generating alternative interpretations...' });
      progress.report({ message: 'Executing 10,000 sandboxed differential tests...' });
      const reportPath = await engine.runFromFunction(fnName, fnSource, workspaceRoot);
      progress.report({ message: 'Opening ambiguity matrix report...' });
      const fileUri = vscode.Uri.file(reportPath);
      await vscode.env.openExternal(fileUri);
      vscode.window.showInformationMessage(
        `Ambiguity Analysis Completed! Report saved to: ${path.basename(reportPath)}`
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Ambiguity Analysis Failed: ${msg}`);
    }
  });
}