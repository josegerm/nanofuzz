import * as ts from 'typescript';
import * as vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import fc from 'fast-check';
export interface DiffLlmConfig {
  apiKey?: string;
  maxInputs?: number;
}
export interface BehaviorData {
  implementations: number[];
  representativeCode: string;
}

export interface AmbiguityClassData {
  behaviors: Record<string, BehaviorData>;
  triggeringInputs: unknown[][];
}

export interface SpecDiscoveryResult {
  totalInputsTested: number;
  consensusCount: number;
  divergenceCount: number;
  ambiguityClasses: Record<string, AmbiguityClassData>;
}
export class DiffLlmEngine {
  private genAI: GoogleGenerativeAI;
  private maxInputs: number;
  constructor(config: DiffLlmConfig = {}) {
    // Resolve the Gemini API key: setting first, then env variable
    const apiKey = config.apiKey || 
      vscode.workspace.getConfiguration('nanofuzz.ai').get<string>('apiKey') || 
      process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      throw new Error(
        'Gemini API Key is missing. Please set it in NaNofuzz extension settings (nanofuzz.ai.apiKey) or export GEMINI_API_KEY in your environment.'
      );
    }
    
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.maxInputs = config.maxInputs || 10000;
  }

  /**
   * 🟢 Greenfield Mode: Discovery from a Natural Language Prompt
   */
  public async runFromPrompt(userPrompt: string, workspaceRoot: string): Promise<string> {
    // Step 1: Planning (infer signature & generate fast-check arbitraries)
    const plan = await this.planFromPrompt(userPrompt);
    
    // Step 2: Generate 4 distinct implementations
    const implementations = await this.generateImplementations(plan.prompt, plan.interfaces, 4);
    
    // Step 3: Run differential testing
    const reportPath = await this.executeDifferentialTesting(
      plan.signature.name,
      plan.signature.params,
      plan.signature.return,
      plan.interfaces,
      plan.arbitrariesCode,
      implementations,
      workspaceRoot
    );
    return reportPath;
  }

  /**
   * 🟤 Brownfield Mode: Discovery from an Existing Function
   */
  public async runFromFunction(
    fnName: string,
    fnSource: string,
    workspaceRoot: string
  ): Promise<string> {
    const fullSource = fnSource;
    // Step 1: Planning for an existing function
    const plan = await this.planFromFunction(fnName, fullSource);
    // Step 2: Generate 3 alternative implementations (total 4 including original)
    const alternatives = await this.generateAlternatives(fnName, fullSource, plan.interfaces, 3);
    const implementations = [fullSource, ...alternatives];
    // Step 3: Run differential testing (original function is Implementation 1)
    const reportPath = await this.executeDifferentialTesting(
      fnName,
      plan.signature.params,
      plan.signature.return,
      plan.interfaces,
      plan.arbitrariesCode,
      implementations,
      workspaceRoot,
      true // Mark that original function is included
    );
    return reportPath;
  }

  private async planFromPrompt(userPrompt: string) {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            prompt: { type: SchemaType.STRING },
            signature: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING },
                params: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                return: { type: SchemaType.STRING }
              },
              required: ["name", "params", "return"]
            },
            interfaces: { type: SchemaType.STRING },
            arbitrariesCode: { type: SchemaType.STRING }
          },
          required: ["prompt", "signature", "interfaces", "arbitrariesCode"]
        }
      }
    });
    const systemInstruction = `
      You are an automated test-harness engineer.
      The user will give you a prompt for a function they want to build.
      Deduce the function name, parameters, and return type, and generate a
      fast-check arbitrary array to test it.
      AVAILABLE INTERFACES:
      export interface Point {
          readonly x: number;
          readonly y: number;
      }
      export interface Rectangle {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
      }
      CRITICAL SIGNATURE RULES:
      'params' MUST be an array of ONLY the raw Typescript types.
      Example: ["Rectangle", "Rectangle"] (DO NOT include parameter names)
      'return' MUST be ONLY the raw type string. Example: "number".
      RULES FOR arbitrariesCode:
      It must be a valid JavaScript array string using the 'fc' library.
      CRITICAL FOR ROBUSTNESS TESTING:
      To find logical ambiguities AND test defensive programming, you MUST allow
      both coordinates AND dimensions (width/height) to be negative, zero, and positive.
      For Rectangle, use: 
          fc.record({ x: fc.integer({min: -20, max: 20}),
                      y: fc.integer({min: -20, max: 20}),
                      width: fc.integer({min: -20, max: 20}),
                      height: fc.integer({min: -20, max: 20}) })
      For Point, use:
          fc.record({ x: fc.integer({min: -20, max: 20}),
                      y: fc.integer({min: -20, max: 20}) })
      Set 'interfaces' to the raw TypeScript code for the interfaces needed.
      Do not use export keywords in the interface block here.
    `;
    const result = await model.generateContent(systemInstruction + '\n\nUser Prompt: ' + userPrompt);
    return JSON.parse(result.response.text());
  }

  private async planFromFunction(fnName: string, sourceCode: string) {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            signature: {
              type: SchemaType.OBJECT,
              properties: {
                name: { type: SchemaType.STRING },
                params: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
                return: { type: SchemaType.STRING }
              },
              required: ["name", "params", "return"]
            },
            interfaces: { type: SchemaType.STRING },
            arbitrariesCode: { type: SchemaType.STRING }
          },
          required: ["signature", "interfaces", "arbitrariesCode"]
        }
      }
    });
    const systemInstruction = `
      You are an automated test-harness engineer.
      The user will provide you with an existing TypeScript function named '${fnName}'.
      Deduce its parameter types and return type, and write a fast-check arbitrary array string using the 'fc' library to fuzz it.
      
      CRITICAL SIGNATURE RULES:
      'params' MUST be an array of ONLY the raw Typescript types.
      Example: ["Rectangle", "Rectangle"] (DO NOT include parameter names)
      'return' MUST be ONLY the raw type string. Example: "number".
      RULES FOR arbitrariesCode:
      It must be a valid JavaScript array string using the 'fc' library. Allow extreme bounds (negative, zero, positive, very large strings, etc.) to expose edge cases in the user's implementation.
      For Point or Rectangle interfaces, use the standard records:
      Rectangle: fc.record({ x: fc.integer({min: -20, max: 20}), y: fc.integer({min: -20, max: 20}), width: fc.integer({min: -20, max: 20}), height: fc.integer({min: -20, max: 20}) })
      Point: fc.record({ x: fc.integer({min: -20, max: 20}), y: fc.integer({min: -20, max: 20}) })
      Set 'interfaces' to any custom TypeScript interface definitions needed for parameters. Keep it empty if using standard primitive types.
    `;
    const result = await model.generateContent(`${systemInstruction}\n\nFunction Name: ${fnName}\nSource Code:\n${sourceCode}`);
    return JSON.parse(result.response.text());
  }

  private async generateImplementations(prompt: string, interfaces: string, count: number): Promise<string[]> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const systemInstruction = `
      You are an expert testing generator.
      Generate exactly ${count} different implementations of this function in TypeScript. 
      
      CRITICAL RULES:
      1. The functions must have the exact same signature, name, and parameters.
      2. The functions MUST be 100% pure, deterministic, and side-effect free. 
      3. Do NOT use Math.random(), Date.now(), or mutate any external state or input arguments.
      4. They should differ ONLY in their internal logic, edge case handling, or performance optimizations.
      5. Do not include interface definitions in your code.
      
      Return ONLY a JSON array of strings, where each string is raw code.
    `;
    const result = await model.generateContent(systemInstruction + '\n\nUser Prompt: ' + prompt);
    const parsed = JSON.parse(result.response.text());
    return parsed.map((code: string) => `${interfaces}\n${code}`);
  }

  private async generateAlternatives(fnName: string, originalSource: string, interfaces: string, count: number): Promise<string[]> {
    const model = this.genAI.getGenerativeModel({
      model: 'gemini-3.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    });
    const systemInstruction = `
      You are an expert testing generator.
      You will be given an existing TypeScript function named '${fnName}' and its source code.
      Generate exactly ${count} ALTERNATIVE implementations of this function. 
      CRITICAL RULES:
      1. The alternatives must have the exact same signature, name, and parameters as the original.
      2. They MUST be 100% pure, deterministic, and side-effect free.
      3. Try to capture different logical interpretations of the requirements, different edge-case handling policies (e.g. how they handle negative inputs, bounds, invalid dimensions, division by zero, empty collections), or optimization variations.
      4. Do not include interface definitions in your code.
      
      Return ONLY a JSON array of strings, where each string is raw code.
    `;
    const result = await model.generateContent(`${systemInstruction}\n\nOriginal Code:\n${originalSource}`);
    const parsed = JSON.parse(result.response.text());
    return parsed.map((code: string) => `${interfaces}\n${code}`);
  }

  private extractSignature(codeString: string, targetFuncName: string):
    { name: string; parameters: string[]; returnType: string } | null {
    const sourceFile = ts.createSourceFile('ai.ts', codeString, ts.ScriptTarget.Latest, true);
    let found: { name: string; parameters: string[]; returnType: string } | null = null;
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === targetFuncName) {
        const params = node.parameters.map(p => p.type ? p.type.getText(sourceFile) : 'any');
        const returnType = node.type ? node.type.getText(sourceFile) : 'any';
        found = { name: node.name.text, parameters: params, returnType };
        return;
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return found;
  }

  private validateImplementation(code: string, expectedName: string, expectedParams: string[], expectedReturn: string): boolean {
    const sig = this.extractSignature(code, expectedName);
    if (!sig) return false;
    const expectedParamsStr = expectedParams.join(', ');
    const actualParamsStr = sig.parameters.join(', ');
    return expectedParamsStr === actualParamsStr && sig.returnType === expectedReturn;
  }

  private compileInSandbox(code: string, funcName: string): (...args: unknown[]) => unknown {
    const sandbox: Record<string, unknown> = { module: { exports: {} } };
    vm.createContext(sandbox);
    const jsCode = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText;
    const script = new vm.Script(`
      ${jsCode}
      module.exports = ${funcName};
    `);
    script.runInContext(sandbox, { timeout: 1000 });
    
    // Extract the exported function from the sandbox
    const module = sandbox['module'];
    if (module !== null && module !== undefined && typeof module === 'object' && 'exports' in module) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any
      const exported = (module as any).exports;
      if (typeof exported === 'function') {
        return exported;
      }
    }
    throw new Error(`Failed to extract function ${funcName} from compiled code`);
  }

  private executeSafely(fn: (...args: unknown[]) => unknown, args: unknown[]) {
    try {
      return { status: 'success', value: fn(...args) };
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : 'Error';
      return { status: 'crashed', errorName };
    }
  }

  private loadArbitraries(codeString: string): fc.Arbitrary<unknown>[] {
    const sandbox = { fc, arbitraries: [] };
    vm.createContext(sandbox);
    vm.runInContext(`arbitraries = ${codeString};`, sandbox);
    return sandbox.arbitraries;
  }

  private async executeDifferentialTesting(
    funcName: string,
    params: string[],
    returnType: string,
    interfaces: string,
    arbitrariesCode: string,
    implementations: string[],
    workspaceRoot: string,
    isBrownfield: boolean = false
  ): Promise<string> {
    // Validate TypeScript AST signatures
    const validGenerations = implementations.filter((code) => 
      this.validateImplementation(code, funcName, params, returnType)
    );
    if (validGenerations.length < 2) {
      throw new Error(
        `Failed to compile or match signatures for AI implementations. Found only ${validGenerations.length} valid implementation(s).`
      );
    }
    const compiledFuncs = validGenerations.map(code => this.compileInSandbox(code, funcName));
    const dynamicArbitraries = this.loadArbitraries(arbitrariesCode);
    // Bypass property runner and sample raw inputs
    const combinedArbitrary = fc.tuple(...dynamicArbitraries);
    const testInputs = fc.sample(combinedArbitrary, { numRuns: this.maxInputs, seed: Date.now() });
    const report: SpecDiscoveryResult = {
      totalInputsTested: this.maxInputs,
      consensusCount: 0,
      divergenceCount: 0,
      ambiguityClasses: {}
    };
    // Evaluate all 10,000 inputs
    for (const args of testInputs) {
      const results = compiledFuncs.map(fn => this.executeSafely(fn, args));
      const baseline = JSON.stringify(results[0]);
      const isConsensus = results.every(res => JSON.stringify(res) === baseline);
      if (isConsensus) {
        report.consensusCount++;
        continue;
      }
      report.divergenceCount++;
      // Group behavior to see who agreed with whom
      const behaviorGroups: Record<string, number[]> = {};
      results.forEach((res, index) => {
        const resStr = JSON.stringify(res);
        if (!behaviorGroups[resStr]) behaviorGroups[resStr] = [];
        behaviorGroups[resStr].push(index);
      });
      // Create split hash
      const splitKey = Object.entries(behaviorGroups)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, indices]) => `Group[${indices.length}]`)
        .join(' VS ');
      if (!report.ambiguityClasses[splitKey]) {
        const breakdownWithCode: Record<string, BehaviorData> = {};
        
        for (const [resStr, indices] of Object.entries(behaviorGroups)) {
          const representativeIndex = indices[0];
          const code = validGenerations[representativeIndex];
          const functionOnly = code.substring(code.indexOf('function ')).trim();
          
          breakdownWithCode[resStr] = {
            implementations: indices.map(i => i + 1), // 1-indexed
            representativeCode: functionOnly
          };
        }
        report.ambiguityClasses[splitKey] = {
          behaviors: breakdownWithCode,
          triggeringInputs: []
        };
      }
      report.ambiguityClasses[splitKey].triggeringInputs.push(args);
    }
    // Save JSON report
    const jsonPath = path.join(workspaceRoot, 'specification_discovery_report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
    // Build Premium Sleek Dark HTML report
    const htmlContent = this.generateHtmlReport(
      funcName, 
      report, 
      validGenerations, 
      isBrownfield
    );
    const htmlPath = path.join(workspaceRoot, 'report.html');
    fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
    return htmlPath;
  }

  private generateHtmlReport(
    funcName: string, 
    report: SpecDiscoveryResult, 
    implementations: string[],
    isBrownfield: boolean
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
    const formatArgValue = (val: unknown): string => {
      if (typeof val === 'object' && val !== null) {
        return '{ ' + Object.entries(val).map(([k, v]) => `${k}: ${v}`).join(', ') + ' }';
      }
      return String(val);
    };
    const formatInputs = (inputs: unknown[]): string => {
      return inputs.map(i => formatArgValue(i)).join(', ');
    };
    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Specification Discovery Report - ${funcName}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&family=Outfit:wght@400;600;800&family=Roboto+Mono:wght@400;500&display=swap');
    
    :root {
      --bg-dark: #0a0e17;
      --bg-card: #121824;
      --border-color: #232c40;
      --text-main: #f0f3f8;
      --text-muted: #8e9bb3;
      --primary: #4f46e5;
      --primary-glow: rgba(79, 70, 229, 0.4);
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg-dark);
      color: var(--text-main);
      margin: 0;
      padding: 2.5rem;
    }
    h1, h2, h3 {
      font-family: 'Outfit', sans-serif;
      margin-top: 0;
    }
    h1 {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, #a5b4fc 0%, #6366f1 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    p.subtitle {
      color: var(--text-muted);
      font-size: 1.1rem;
      margin-bottom: 2rem;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 1.5rem;
      margin-bottom: 3rem;
    }
    .metric-card {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      transition: all 0.3s ease;
    }
    .metric-card:hover {
      transform: translateY(-2px);
      border-color: var(--primary);
      box-shadow: 0 4px 25px var(--primary-glow);
    }
    .metric-val {
      font-size: 2.2rem;
      font-weight: 700;
      font-family: 'Outfit', sans-serif;
      color: var(--primary);
      margin-bottom: 0.25rem;
    }
    .metric-label {
      color: var(--text-muted);
      font-size: 0.9rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .class-container {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 2rem;
      margin-bottom: 2.5rem;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.15);
    }
    .class-title {
      font-size: 1.5rem;
      font-weight: 700;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 0.75rem;
      margin-bottom: 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .class-tag {
      background: rgba(239, 68, 68, 0.15);
      color: var(--danger);
      font-size: 0.8rem;
      padding: 0.4rem 0.8rem;
      border-radius: 20px;
      border: 1px solid rgba(239, 68, 68, 0.3);
      font-weight: 600;
    }
    .code-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }
    .code-card {
      background: #070a10;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      overflow: hidden;
    }
    .code-header {
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid var(--border-color);
      padding: 0.75rem 1rem;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .code-header span.impl-label {
      color: var(--text-main);
    }
    .code-header span.return-val {
      color: var(--success);
      font-family: 'Roboto Mono', monospace;
    }
    .code-block {
      margin: 0;
      padding: 1.25rem;
      overflow-x: auto;
      font-family: 'Roboto Mono', monospace;
      font-size: 0.9rem;
      line-height: 1.5;
      color: #e2e8f0;
    }
    .table-container {
      background: #070a10;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      overflow: hidden;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-family: 'Roboto Mono', monospace;
      font-size: 0.85rem;
      text-align: left;
    }
    th, td {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border-color);
    }
    th {
      background-color: rgba(255, 255, 255, 0.02);
      font-family: 'Inter', sans-serif;
      font-weight: 600;
      color: var(--text-muted);
    }
    tr:last-child td {
      border-bottom: none;
    }
    tr:hover td {
      background-color: rgba(255, 255, 255, 0.01);
    }
    .crashed-tag {
      color: var(--danger);
      font-weight: bold;
    }
    .success-tag {
      color: var(--success);
    }
  </style>
</head>
<body>
  <h1>🔍 Specification Discovery Report</h1>
  <p class="subtitle">Differential fuzzing matrix for function <strong>${funcName}</strong> (${isBrownfield ? 'Brownfield Verification' : 'Greenfield Synthesis'})</p>
  
  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-val" style="color: var(--text-main);">${report.totalInputsTested.toLocaleString()}</div>
      <div class="metric-label">Inputs Fuzzed</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: var(--success);">${report.consensusCount.toLocaleString()}</div>
      <div class="metric-label">Consensus Agree</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: ${report.divergenceCount > 0 ? 'var(--danger)' : 'var(--success)'};">${report.divergenceCount.toLocaleString()}</div>
      <div class="metric-label">Diverging Edge Cases</div>
    </div>
    <div class="metric-card">
      <div class="metric-val" style="color: var(--warning);">${Object.keys(report.ambiguityClasses).length}</div>
      <div class="metric-label">Ambiguity Classes</div>
    </div>
  </div>
  `;
    if (report.divergenceCount === 0) {
      html += `
      <div class="class-container" style="border-color: var(--success); text-align: center; padding: 4rem 2rem;">
        <h2 style="color: var(--success); font-size: 2rem; margin-bottom: 0.5rem;">🎉 Perfect Consensus Reached!</h2>
        <p style="color: var(--text-muted); max-width: 600px; margin: 0 auto;">All generated implementations behaved in the exact same deterministic way across all ${report.totalInputsTested.toLocaleString()} test runs. There are no specification ambiguities identified.</p>
      </div>`;
    } else {
      let classIndex = 1;
      for (const [splitName, classData] of Object.entries(report.ambiguityClasses)) {
        const behaviors = Object.entries(classData.behaviors);
        html += `
        <div class="class-container">
          <div class="class-title">
            <span>🛑 Ambiguity Class ${classIndex}: ${splitName}</span>
            <span class="class-tag">${classData.triggeringInputs.length} triggering inputs</span>
          </div>
          <div class="code-grid">`;
        behaviors.forEach(([resultStr, details]) => {
          const isOriginal = isBrownfield && details.implementations.includes(1);
          const label = isOriginal ? "YOUR ORIGINAL FUNCTION" : `Impls [${details.implementations.join(', ')}]`;
          const resultParsed = JSON.parse(resultStr);
          const returnDisplay = resultParsed.status === 'crashed' 
            ? `<span class="crashed-tag">CRASHED (${resultParsed.errorName})</span>` 
            : `<span class="success-tag">returns ${escapeHtml(JSON.stringify(resultParsed.value))}</span>`;
          html += `
            <div class="code-card" ${isOriginal ? 'style="border-color: var(--primary); box-shadow: 0 4px 15px rgba(79,70,229,0.2)"' : ''}>
              <div class="code-header">
                <span class="impl-label" ${isOriginal ? 'style="color: #818cf8; font-weight: bold;"' : ''}>${label}</span>
                <span class="return-val">${returnDisplay}</span>
              </div>
              <pre class="code-block"><code>${escapeHtml(details.representativeCode)}</code></pre>
            </div>`;
        });
        html += `
          </div>
          <h3 style="font-size: 1.1rem; margin-bottom: 1rem; color: var(--text-muted);">📋 Sample Triggering Inputs</h3>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th style="width: 50px;">#</th>
                  <th>Function Arguments</th>`;
        behaviors.forEach(([_, details]) => {
          const isOriginal = isBrownfield && details.implementations.includes(1);
          html += `<th>${isOriginal ? "Your Code" : `Impls ${details.implementations.join(', ')}`}</th>`;
        });
        html += `
                </tr>
              </thead>
              <tbody>`;
        // Display up to 10 sample triggering inputs for readability
        const samples = classData.triggeringInputs.slice(0, 10);
        samples.forEach((args: unknown[], index: number) => {
          html += `
                <tr>
                  <td>${index + 1}</td>
                  <td style="color: #60a5fa; font-weight: 500;">${escapeHtml(formatInputs(args))}</td>`;
          behaviors.forEach(([resultStr, _]) => {
            const resultParsed = JSON.parse(resultStr);
            const display = resultParsed.status === 'crashed' 
              ? `<span class="crashed-tag">CRASHED (${resultParsed.errorName})</span>` 
              : `<span class="success-tag">${escapeHtml(JSON.stringify(resultParsed.value))}</span>`;
            html += `<td>${display}</td>`;
          });
          html += `
                </tr>`;
        });
        html += `
              </tbody>
            </table>
          </div>
        </div>`;
        classIndex++;
      }
    }
    html += `
</body>
</html>`;
    return html;
  }
}