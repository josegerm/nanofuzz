import * as vscode from 'vscode';
import { DiffLlmEngine, SpecDiscoveryResult } from './DiffLlmEngine';
import { FunctionMatch } from '../ui/FuzzPanel';
export const commands = {
  diffLlmPrompt: {
    name: 'nanofuzz.diffLlmPrompt',
    fn: handleDiffLlmPromptCommand
  },
  diffLlmFunction: {
    name: 'nanofuzz.diffLlmFunction',
    fn: handleDiffLlmFunctionCommand
  },
  diffLlmSpec: {
    name: 'nanofuzz.diffLlmSpec',
    fn: handleDiffLlmSpecCommand
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
      const result = await engine.runFromPrompt(userPrompt, workspaceRoot);
      progress.report({ message: 'Displaying results in side panel...' });
      
      // Create webview panel with results
      const panel = vscode.window.createWebviewPanel(
        'diffLlmResults',
        'DiffLlm: Prompt-based Discovery',
        vscode.ViewColumn.Beside,
        {}
      );
      const html = generateDiffLlmHtml('AI-Generated Function', [], userPrompt, result);
      panel.webview.html = html;
      
      vscode.window.showInformationMessage(
        `Specification Discovery Completed! Results displayed in side panel.`
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
      const result = await engine.runFromFunction(fnName, fnSource, workspaceRoot);
      progress.report({ message: 'Displaying results in side panel...' });
      
      // Create webview panel with results
      const panel = vscode.window.createWebviewPanel(
        'diffLlmResults',
        `DiffLlm: ${fnName}`,
        vscode.ViewColumn.Beside,
        {}
      );
      const html = generateDiffLlmHtml(fnName, [], `Analyzing existing function: ${fnName}`, result);
      panel.webview.html = html;
      
      vscode.window.showInformationMessage(
        `Ambiguity Analysis Completed! Results displayed in side panel.`
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Ambiguity Analysis Failed: ${msg}`);
    }
  });
}

/**
 * Specification Mode: Generate and Test from Function Signature and JSDoc
 */
async function handleDiffLlmSpecCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Please open a file in the editor first.');
    return;
  }

  // Get the current line where the cursor is
  const cursorLine = editor.selection.active.line;
  const document = editor.document;
  
  // Look for a function definition near the cursor (search within 10 lines)
  let fnName: string | null = null;
  let params: string[] = [];
  let jsDocComment: string | null = null;
  
  // Search upwards for JSDoc comment
  for (let i = cursorLine; i >= Math.max(0, cursorLine - 20); i--) {
    const line = document.lineAt(i).text;
    
    // Check if this is a JSDoc comment
    if (line.trim().startsWith('/**')) {
      // Collect all JSDoc comment lines
      const docLines: string[] = [];
      for (let j = i; j < document.lineCount; j++) {
        const docLine = document.lineAt(j).text;
        docLines.push(docLine);
        if (docLine.includes('*/')) {
          break;
        }
      }
      
      // Look for the function definition immediately after the JSDoc
      const startLine = i + docLines.length;
      for (let j = startLine; j < Math.min(startLine + 5, document.lineCount); j++) {
        const defLine = document.lineAt(j).text.trim();
        const fnMatch = defLine.match(/function\s+(\w+)\s*\((.*?)\)/);
        if (fnMatch) {
          fnName = fnMatch[1];
          const paramStr = fnMatch[2].trim();
          // Parse parameters - simple parsing that handles type annotations
          if (paramStr) {
            // Extract just the types (simple version)
            const paramParts = paramStr.split(',').map(p => {
              const match = p.trim().match(/:\s*(\w+|\w+\[\]|\{\s*[^}]*\})/);
              return match ? match[1].trim() : p.trim().split(':')[0].trim();
            });
            params = paramParts.filter(p => p.length > 0);
          }
          
          // Extract specification from JSDoc
          const jsDocText = docLines
            .map(l => l.replace(/^\s*\*\s?/, '').replace(/^\s*\/\*\*\s?/, '').replace(/^\s*\*\/\s?/, ''))
            .join(' ')
            .trim();
          jsDocComment = jsDocText;
          break;
        }
      }
      
      if (fnName && jsDocComment) {
        break;
      }
    }
  }
  
  // If we couldn't find a function with JSDoc, prompt the user
  if (!fnName || !jsDocComment) {
    // Prompt for function name
    const manualFnName = await vscode.window.showInputBox({
      prompt: 'Enter the function name',
      placeHolder: 'e.g., calculateArea',
      ignoreFocusOut: true,
      value: fnName || ''
    });
    if (!manualFnName) {
      return; // User cancelled
    }
    fnName = manualFnName;

    // Prompt for parameter types
    const paramsInput = await vscode.window.showInputBox({
      prompt: 'Enter parameter types (comma-separated)',
      placeHolder: 'e.g., Rectangle or number, string',
      ignoreFocusOut: true
    });
    if (!paramsInput) {
      return; // User cancelled
    }
    params = paramsInput.split(',').map(p => p.trim()).filter(p => p.length > 0);

    // Prompt for JSDoc specification (multi-line)
    const specDoc = await vscode.workspace.openTextDocument({
      language: 'plaintext',
      content: ''
    });
    const specEditor = await vscode.window.showTextDocument(specDoc, vscode.ViewColumn.Active);
    specEditor.edit(editBuilder => {
      editBuilder.insert(new vscode.Position(0, 0), 
        'Enter the function specification here (what it should do).\n' +
        'You can use multiple lines.\n' +
        'When done, close this editor to continue.\n' +
        '--- Specification below this line ---\n'
      );
    });
    
    // Wait for the editor to be closed
    const closedSubscription = vscode.window.onDidChangeActiveTextEditor(() => {
      // Just track when editor changes
    });
    
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        const allEditors = vscode.window.visibleTextEditors;
        if (!allEditors.find(e => e.document === specDoc)) {
          clearInterval(checkInterval);
          closedSubscription.dispose();
          resolve();
        }
      }, 100);
    });
    
    let specification = specDoc.getText();
    // Remove the instruction lines
    const lines = specification.split('\n');
    const specStartIndex = lines.findIndex(l => l.includes('--- Specification below this line ---'));
    if (specStartIndex !== -1) {
      specification = lines.slice(specStartIndex + 1).join('\n').trim();
    }
    
    if (!specification) {
      vscode.window.showErrorMessage('Function specification is required. Please provide a specification comment.');
      return;
    }
    jsDocComment = specification;
  }

  const workspaceRoot = getWorkspaceRoot();
  
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `NaNofuzz: Generating ${fnName}`,
    cancellable: false
  }, async (progress) => {
    try {
      progress.report({ message: 'Initializing Gemini spec analyzer...' });
      const engine = new DiffLlmEngine();
      
      progress.report({ message: 'Analyzing specification and generating Fast-Check arbitraries...' });
      progress.report({ message: 'Generating alternative AI implementations...' });
      progress.report({ message: 'Executing 10,000 differential fuzzing runs in V8 sandbox...' });
      
      const result = await engine.runFromSpecification(fnName, params, jsDocComment, workspaceRoot);
      
      progress.report({ message: 'Displaying results in side panel...' });
      
      // Create and show the DiffLlm panel
      const panelTitle = `DiffLlm: ${fnName}`;
      const panel = vscode.window.createWebviewPanel(
        'diffLlmResults',
        panelTitle,
        vscode.ViewColumn.Beside,
        { enableScripts: false }
      );
      
      panel.webview.html = generateDiffLlmHtml(fnName, params, jsDocComment, result);
      
      vscode.window.showInformationMessage(
        `Specification Analysis Completed! Results displayed in side panel.`
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Specification Analysis Failed: ${msg}`);
    }
  });
}

/**
 * Generate HTML for DiffLlm results panel
 */
function generateDiffLlmHtml(
  fnName: string,
  params: string[],
  specification: string,
  result: SpecDiscoveryResult
): string {
  const escapeHtml = (unsafe: unknown): string => {
    const s = String(unsafe ?? '');
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  const formatValue = (val: unknown): string => {
    if (typeof val === 'object' && val !== null) {
      return JSON.stringify(val);
    }
    return String(val);
  };

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DiffLlm: ${fnName}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      margin: 0;
      padding: 12px;
      color: #d4d4d4;
      background-color: #1e1e1e;
      font-size: 13px;
    }
    h1 {
      font-size: 16px;
      margin: 0 0 8px 0;
      color: #fff;
      font-weight: 600;
    }
    h2 {
      font-size: 13px;
      margin: 12px 0 8px 0;
      color: #4fc3f7;
      font-weight: 600;
    }
    .spec-box {
      background: #252526;
      border: 1px solid #3e3e42;
      padding: 10px;
      border-radius: 4px;
      margin-bottom: 12px;
      font-size: 12px;
      line-height: 1.4;
    }
    .metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 12px;
    }
    .metric-card {
      background: #252526;
      border-left: 3px solid #4fc3f7;
      padding: 8px;
      border-radius: 2px;
    }
    .metric-label {
      color: #858585;
      font-size: 11px;
      text-transform: uppercase;
    }
    .metric-value {
      font-size: 18px;
      font-weight: bold;
      color: #4fc3f7;
    }
    .test-case {
      background: #252526;
      border: 1px solid #3e3e42;
      padding: 10px;
      margin-bottom: 8px;
      border-radius: 3px;
    }
    .test-header {
      background: #1e1e1e;
      padding: 6px 8px;
      margin: -10px -10px 8px -10px;
      border-radius: 3px 3px 0 0;
      border-bottom: 1px solid #3e3e42;
      font-weight: 600;
      color: #ff6b6b;
    }
    .input-section {
      margin-bottom: 8px;
      padding: 6px;
      background: #1a1a1b;
      border-radius: 2px;
      font-family: 'Monaco', monospace;
      font-size: 11px;
      color: #ce9178;
      word-break: break-all;
    }
    .input-label {
      color: #6a9955;
      font-weight: bold;
      margin-bottom: 2px;
    }
    .impl-output {
      margin-bottom: 6px;
      padding: 6px;
      background: #1a1a1b;
      border-radius: 2px;
      font-family: 'Monaco', monospace;
      font-size: 11px;
      border-left: 2px solid #4fc3f7;
    }
    .impl-label {
      color: #4fc3f7;
      font-weight: bold;
      margin-bottom: 2px;
    }
    .output {
      color: #ce9178;
      word-break: break-all;
    }
    .crashed {
      color: #f48771;
    }
    .consensus {
      background: #1a3a1a;
      border: 1px solid #2d5a2d;
      padding: 10px;
      border-radius: 4px;
      color: #4caf50;
      text-align: center;
    }
    .no-divergence {
      color: #999;
      text-align: center;
      padding: 20px;
    }
  </style>
</head>
<body>
  <h1>🔍 ${escapeHtml(fnName)}</h1>
  
  <div class="spec-box">
    <strong>Specification:</strong> ${escapeHtml(specification)}<br>
    <strong>Parameters:</strong> ${escapeHtml(params.join(', '))}
  </div>
  
  <h2>Test Results</h2>
  <div class="metrics">
    <div class="metric-card">
      <div class="metric-label">Total Tests</div>
      <div class="metric-value">${result.totalInputsTested.toLocaleString()}</div>
    </div>
    <div class="metric-card">
      <div class="metric-label">Divergences</div>
      <div class="metric-value" style="color: ${result.divergenceCount > 0 ? '#f48771' : '#4caf50'}">${result.divergenceCount.toLocaleString()}</div>
    </div>
  </div>`;

  if (result.divergenceCount === 0) {
    html += `
  <div class="consensus">
    <strong>✓ Perfect Consensus</strong><br>
    All implementations behave identically.
  </div>`;
  } else {
    html += `<h2>Divergent Test Cases (${Math.min(20, result.divergentTests.length)} of ${result.divergenceCount})</h2>`;
    
    result.divergentTests.forEach((test, index) => {
      const impl1Result = test.impl1.result;
      const impl2Result = test.impl2.result;
      
      const impl1Display = impl1Result.status === 'crashed' 
        ? `<span class="crashed">CRASHED: ${impl1Result.errorName}</span>`
        : `<span class="output">${escapeHtml(formatValue(impl1Result.value))}</span>`;
        
      const impl2Display = impl2Result.status === 'crashed' 
        ? `<span class="crashed">CRASHED: ${impl2Result.errorName}</span>`
        : `<span class="output">${escapeHtml(formatValue(impl2Result.value))}</span>`;
      
      const inputs = test.input;
      
      html += `
  <div class="test-case">
    <div class="test-header">Test Case ${index + 1}</div>
    <div class="input-section">
      <div class="input-label">Input:</div>
      ${inputs.map(arg => `<div>${escapeHtml(formatValue(arg))}</div>`).join('')}
    </div>
    <div class="impl-output">
      <div class="impl-label">Implementation 1:</div>
      ${impl1Display}
    </div>
    <div class="impl-output">
      <div class="impl-label">Implementation 2:</div>
      ${impl2Display}
    </div>
  </div>`;
    });
  }

  html += `</body></html>`;
  return html;
}