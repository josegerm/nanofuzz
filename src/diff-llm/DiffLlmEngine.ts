import * as ts from 'typescript';
import * as vm from 'node:vm';
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import fc from 'fast-check';

export interface DiffLlmConfig {
  apiKey?: string;
  baseUrl?: string;
  maxInputs?: number;
}

export interface DivergentTest {
  input: unknown[];
  impl1: { code: string; result: { status: string; value?: unknown; errorName?: string } };
  impl2: { code: string; result: { status: string; value?: unknown; errorName?: string } };
  failCount: number;
}

export interface SpecDiscoveryResult {
  totalInputsTested: number;
  consensusCount: number;
  divergenceCount: number;
  divergentTests: DivergentTest[];
  implementations?: string[];
}

interface ImplementationSignatureContext {
  name: string;
  params: string[];
  returnType: string;
  parameterNames?: string[];
  specification?: string;
  sourceCode?: string;
}

export class DiffLlmEngine {
  private genAI: GoogleGenerativeAI;
  private baseUrl: string;
  private maxInputs: number;
  
  constructor(apiKey: string, baseUrl: string, maxInputs?: number) {
    if (!apiKey) {
      throw new Error(
        'AI Gateway API Key is missing. Please set your key using the Command Palette (NaNofuzz: Set Gemini API Key).'
      );
    }

    if (!baseUrl) {
      throw new Error(
        'AI Gateway Base URL is missing. Please set your base URL using the Command Palette (NaNofuzz: Set Gemini API Key).'
      );
    }
    
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.maxInputs = maxInputs || 10000;
  }

  /**
   * 🟢 Greenfield Mode: Discovery from a Natural Language Prompt
   */
  public async runFromPrompt(userPrompt: string, workspaceRoot: string): Promise<SpecDiscoveryResult> {
    // Step 1: Planning (infer signature & generate fast-check arbitraries)
    const plan = await this.planFromPrompt(userPrompt);
    
    // Step 2: Generate 2 distinct implementations from the prompt and inferred signature
    const implementations = await this.generateImplementations(plan.prompt, plan.interfaces, 2, {
      name: plan.signature.name,
      params: plan.signature.params,
      returnType: plan.signature.return,
      specification: userPrompt
    });
    
    // Step 3: Run differential testing
    const result = await this.executeDifferentialTesting(
      plan.signature.name,
      plan.signature.params,
      plan.signature.return,
      plan.interfaces,
      plan.arbitrariesCode,
      implementations,
      workspaceRoot,
      false
    );
    result.implementations = implementations;
    return result;
  }

  /**
   * 🟤 Brownfield Mode: Discovery from an Existing Function
   */
  public async runFromFunction(
    fnName: string,
    fnSource: string,
    workspaceRoot: string
  ): Promise<SpecDiscoveryResult> {
    const fullSource = fnSource;
    // Step 1: Planning for an existing function
    const plan = await this.planFromFunction(fnName, fullSource);
    const parameterNames = this.extractParameterNames(fullSource, fnName);
    // Step 2: Generate two new implementations and compare those directly
    const implementations = await this.generateAlternatives(fnName, fullSource, plan.interfaces, 2, {
      name: plan.signature.name || fnName,
      params: plan.signature.params,
      returnType: plan.signature.return,
      parameterNames,
      sourceCode: fullSource
    });
    // Step 3: Run differential testing (original function is Implementation 1)
    const result = await this.executeDifferentialTesting(
      plan.signature.name || fnName,
      plan.signature.params,
      plan.signature.return,
      plan.interfaces,
      plan.arbitrariesCode,
      implementations,
      workspaceRoot,
      true
    );
    result.implementations = implementations;
    return result;
  }

  /**
   * 🔵 Specification Mode: Generate from Function Signature and JSDoc Comment
   */
  public async runFromSpecification(
    fnName: string,
    params: string[],
    specification: string,
    workspaceRoot: string,
    fnSource?: string
  ): Promise<SpecDiscoveryResult> {
    let plan;
    
    // Fallback switch check
    if (!specification || specification.trim().length === 0) {
      if (!fnSource) {
        throw new Error(`No specification comment found, and no underlying source code was provided for fallback analysis.`);
      }
      // Pivot directly to structural source analysis
      plan = await this.planFromFunction(fnName, fnSource);
    } else {
      // Execute original specification mode planning
      plan = await this.planFromSpecification(fnName, params, specification);
    }
    
    // Step 2: Generate 2 distinct implementations from the specification or the supplied source
    const implementations = await this.generateImplementations(plan.prompt, plan.interfaces, 2, {
      name: plan.signature.name || fnName,
      params: plan.signature.params,
      returnType: plan.signature.return,
      specification: specification && specification.trim().length > 0 ? specification : undefined,
      sourceCode: fnSource,
      parameterNames: fnSource ? this.extractParameterNames(fnSource, fnName) : undefined
    });
    
    // Step 3: Run differential testing
    const result = await this.executeDifferentialTestingDirect(
      plan.signature.name || fnName,
      plan.signature.params,
      plan.signature.return,
      plan.interfaces,
      plan.arbitrariesCode,
      implementations
    );

    // >>> REQ 2: Append implementations to payload so Webview can render them <<<
    result.implementations = implementations;
    return result;
  }

  private async planFromPrompt(userPrompt: string) {
    const model = this.genAI.getGenerativeModel(
      {
        model: 'models/gemini/gemini-3.5-flash',
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
    },
    { 
      baseUrl: this.baseUrl
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
      model: 'models/gemini/gemini-3.5-flash',
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
    },
    { 
      baseUrl: this.baseUrl
    });
    const systemInstruction = `
      You are an automated test-harness engineer.
      The user will provide you with an existing TypeScript function named '${fnName}'.
      Deduce its parameter types and return type, and write a fast-check arbitrary array string using the 'fc' library to fuzz it.
      
      CRITICAL SIGNATURE RULES:
      'params' MUST be an array of ONLY the raw Typescript types.
      Example: ["Rectangle", "Rectangle"] (DO NOT include parameter names)
      'return' MUST be ONLY the raw type string. Example: "number".
      
      AVAILABLE FAST-CHECK FUNCTIONS:
      - fc.integer({min, max}): generates integers in range
      - fc.nat(): generates non-negative integers
      - fc.boolean(): generates booleans
      - fc.string(): generates strings
      - fc.array(arb): generates arrays of arbitraries
      - fc.record({key: arb}): generates objects with specified properties
      - fc.tuple(...arbs): generates tuples
      - fc.float({min, max}): generates floating point numbers
      
      RULES FOR arbitrariesCode:
      It must be a valid JavaScript array string using ONLY the functions above. Allow extreme bounds (negative, zero, positive, very large strings, etc.) to expose edge cases.
      NEVER use fc.oneOf, fc.sampled, fc.option, fc.maybe, fc.chain, or other functions not listed above.
      For Point or Rectangle interfaces, use the standard records:
      Rectangle: fc.record({ x: fc.integer({min: -20, max: 20}), y: fc.integer({min: -20, max: 20}), width: fc.integer({min: -20, max: 20}), height: fc.integer({min: -20, max: 20}) })
      Point: fc.record({ x: fc.integer({min: -20, max: 20}), y: fc.integer({min: -20, max: 20}) })
      Set 'interfaces' to any custom TypeScript interface definitions needed for parameters. Keep it empty if using standard primitive types.
    `;
    const result = await model.generateContent(`${systemInstruction}\n\nFunction Name: ${fnName}\nSource Code:\n${sourceCode}`);
    return JSON.parse(result.response.text());
  }

  private async planFromSpecification(fnName: string, params: string[], specification: string) {
    const model = this.genAI.getGenerativeModel({
      model: 'models/gemini/gemini-3.5-flash',
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
    },
    { 
      baseUrl: this.baseUrl
    });
    const systemInstruction = `
      You are an automated test-harness engineer.
      The user provides a function name, parameter types, and a specification comment.
      Your task is to:
      1. Parse the specification to understand what the function should do
      2. Generate a prompt suitable for AI implementation generation
      3. Infer or confirm the return type from the specification
      4. Create a fast-check arbitrary array to test the function
      
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
      'return' MUST be ONLY the raw type string.
      
      AVAILABLE FAST-CHECK FUNCTIONS:
      - fc.integer({min, max}): generates integers in range
      - fc.nat(): generates non-negative integers
      - fc.boolean(): generates booleans
      - fc.string(): generates strings
      - fc.array(arb): generates arrays of arbitraries
      - fc.record({key: arb}): generates objects with specified properties
      - fc.tuple(...arbs): generates tuples
      - fc.float({min, max}): generates floating point numbers
      
      RULES FOR arbitrariesCode:
      It must be a valid JavaScript array string using ONLY the functions above.
      Allow extreme bounds (negative, zero, positive, very large strings, etc.) to expose edge cases.
      NEVER use fc.oneOf, fc.sampled, fc.option, fc.maybe, fc.chain, or other functions not listed above.
      Set 'interfaces' to the raw TypeScript code for the interfaces needed.
      Do not use export keywords in the interface block here.
    `;
    const paramsStr = params.join(', ');
    const result = await model.generateContent(
      `${systemInstruction}\n\nFunction Name: ${fnName}\nParameter Types: [${paramsStr}]\nSpecification:\n${specification}`
    );
    return JSON.parse(result.response.text());
  }

  private async generateImplementations(
    prompt: string,
    interfaces: string,
    count: number,
    signatureContext?: ImplementationSignatureContext
  ): Promise<string[]> {
    const model = this.genAI.getGenerativeModel({
      model: 'models/gemini/gemini-3.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    },
    { 
      baseUrl: this.baseUrl
    });
    const systemInstruction = `
      You are an expert testing generator.
      Generate exactly ${count} different implementations of this function in TypeScript. 
      
      CRITICAL RULES:
      1. The functions must have the exact same signature, name, and parameters as the requested target.
      2. The functions MUST be 100% pure, deterministic, and side-effect free. 
      3. Do NOT use Math.random(), Date.now(), or mutate any external state or input arguments.
      4. They should differ ONLY in their internal logic, edge case handling, or performance optimizations.
      5. Do not include interface definitions in your code.
      6. If a specification or source snippet is provided, implement directly from that source of truth instead of inventing behavior.
      
      Return ONLY a JSON array of strings, where each string is raw code.
    `;
    const implementationPrompt = this.buildImplementationPrompt(prompt, signatureContext);
    const result = await model.generateContent(systemInstruction + '\n\n' + implementationPrompt);
    return this.parseImplementationResponse(result.response.text(), interfaces);
  }

  private async generateAlternatives(
    fnName: string,
    originalSource: string,
    interfaces: string,
    count: number,
    signatureContext?: ImplementationSignatureContext
  ): Promise<string[]> {
    const model = this.genAI.getGenerativeModel({
      model: 'models/gemini/gemini-3.5-flash',
      generationConfig: { responseMimeType: 'application/json' }
    },
    { 
      baseUrl: this.baseUrl
    });
    const systemInstruction = `
      You are an expert testing generator.
      You will be given an existing TypeScript function and its source code.
      Generate exactly ${count} ALTERNATIVE implementations of this function. 
      CRITICAL RULES:
      1. The alternatives must have the exact same signature, name, and parameters as the original.
      2. They MUST be 100% pure, deterministic, and side-effect free.
      3. Use the supplied source of truth directly, especially the specification or implementation comments, and preserve the intended behavior.
      4. Try to capture different logical interpretations of the requirements, different edge-case handling policies (e.g. how they handle negative inputs, bounds, invalid dimensions, division by zero, empty collections), or optimization variations.
      5. Do not include interface definitions in your code.
      
      Return ONLY a JSON array of strings, where each string is raw code.
    `;
    const implementationPrompt = this.buildImplementationPrompt(originalSource, signatureContext);
    const result = await model.generateContent(`${systemInstruction}\n\n${implementationPrompt}`);
    return this.parseImplementationResponse(result.response.text(), interfaces);
  }

  private parseImplementationResponse(rawText: string, interfaces: string): string[] {
    const trimmed = rawText.trim();
    const candidates = [trimmed];

    const fencedMatch = trimmed.match(/```(?:ts|typescript)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      candidates.push(fencedMatch[1].trim());
    }

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
          return parsed.map((code) => `${interfaces}\n${String(code)}`);
        }
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { implementations?: unknown[] }).implementations)) {
          return (parsed as { implementations: unknown[] }).implementations.map((code) => `${interfaces}\n${String(code)}`);
        }
      } catch {
        // Try a simple fallback parse for bracketed arrays in plain text.
      }
    }

    const arrayMatch = trimmed.match(/\[(.*?)\]/s);
    if (arrayMatch?.[1]) {
      const parts = arrayMatch[1]
        .split(/","|','/)
        .map((part) => part.replace(/^\s*["']|["']\s*$/g, '').trim())
        .filter(Boolean);
      if (parts.length > 0) {
        return parts.map((code) => `${interfaces}\n${code}`);
      }
    }

    return [trimmed].map((code) => `${interfaces}\n${code}`);
  }

  private buildImplementationPrompt(prompt: string, signatureContext?: ImplementationSignatureContext): string {
    const lines: string[] = [];
    lines.push('Target function request:');
    lines.push(prompt);

    if (signatureContext) {
      const paramNames = signatureContext.parameterNames && signatureContext.parameterNames.length > 0
        ? signatureContext.parameterNames
        : signatureContext.params.map((_, index) => `arg${index + 1}`);
      const signature = `${signatureContext.name}(${paramNames.map((name, index) => `${name}: ${signatureContext.params[index] || 'unknown'}`).join(', ')})${signatureContext.returnType ? `: ${signatureContext.returnType}` : ''}`;
      lines.push(`Required signature: ${signature}`);

      if (signatureContext.specification) {
        lines.push('Implementation source of truth (specification/comment):');
        lines.push(signatureContext.specification);
      }

      if (signatureContext.sourceCode) {
        lines.push('Implementation source of truth (existing function):');
        lines.push(signatureContext.sourceCode);
      }
    }

    return lines.join('\n\n');
  }

  private extractParameterNames(sourceCode: string, targetFuncName: string): string[] {
    const sourceFile = ts.createSourceFile('function.ts', sourceCode, ts.ScriptTarget.Latest, true);
    let found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === targetFuncName) {
        found = node.parameters.map((param) => param.name.getText(sourceFile));
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
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
    try {
      const sandbox = { 
        fc, 
        arbitraries: [],
        // Expose fc to global scope in the VM context
        global: {}
      };
      vm.createContext(sandbox);
      // Ensure fc is available in the execution context
      sandbox.global = sandbox;
      const wrappedCode = `
        var arbitraries = ${codeString};
      `;
      vm.runInContext(wrappedCode, sandbox);
      if (sandbox && typeof sandbox === 'object' && 'arbitraries' in sandbox) {
        const arbs = sandbox.arbitraries;
        return Array.isArray(arbs) ? arbs : [];
      }
      return [];
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load arbitraries: ${errorMsg}`, { cause: error });
    }
  }

  private async executeDifferentialTesting(
    funcName: string,
    params: string[],
    returnType: string,
    interfaces: string,
    arbitrariesCode: string,
    implementations: string[],
    _workspaceRoot: string,
    _isBrownfield: boolean = false
  ): Promise<SpecDiscoveryResult> {
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
    const combinedArbitrary = fc.tuple(...dynamicArbitraries);
    const testInputs = fc.sample(combinedArbitrary, { numRuns: this.maxInputs, seed: Date.now() });
    const report: SpecDiscoveryResult = {
      totalInputsTested: this.maxInputs,
      consensusCount: 0,
      divergenceCount: 0,
      divergentTests: []
    };
    const divergentByInput = new Map<string, DivergentTest>();

    for (const args of testInputs) {
      const results = compiledFuncs.map(fn => this.executeSafely(fn, args));
      const baseline = JSON.stringify(results[0]);
      const isConsensus = results.every(res => JSON.stringify(res) === baseline);
      if (isConsensus) {
        report.consensusCount++;
        continue;
      }
      report.divergenceCount++;

      const inputKey = this.createStableInputKey(args);
      const existing = divergentByInput.get(inputKey);
      if (existing) {
        existing.failCount += 1;
        continue;
      }

      const impl1Code = validGenerations[0].trim();
      const impl2Code = validGenerations[1].trim();
      divergentByInput.set(inputKey, {
        input: args,
        impl1: {
          code: impl1Code,
          result: results[0]
        },
        impl2: {
          code: impl2Code,
          result: results[1]
        },
        failCount: 1
      });
    }

    report.divergentTests = Array.from(divergentByInput.values()).sort((a, b) => b.failCount - a.failCount);
    return report;
  }

  private async executeDifferentialTestingDirect(
    funcName: string,
    params: string[],
    returnType: string,
    interfaces: string,
    arbitrariesCode: string,
    implementations: string[]
  ): Promise<SpecDiscoveryResult> {
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
    const combinedArbitrary = fc.tuple(...dynamicArbitraries);
    const testInputs = fc.sample(combinedArbitrary, { numRuns: this.maxInputs, seed: Date.now() });
    const report: SpecDiscoveryResult = {
      totalInputsTested: this.maxInputs,
      consensusCount: 0,
      divergenceCount: 0,
      divergentTests: []
    };
    const divergentByInput = new Map<string, DivergentTest>();

    for (const args of testInputs) {
      const results = compiledFuncs.map(fn => this.executeSafely(fn, args));
      const baseline = JSON.stringify(results[0]);
      const isConsensus = results.every(res => JSON.stringify(res) === baseline);
      if (isConsensus) {
        report.consensusCount++;
        continue;
      }
      report.divergenceCount++;

      const inputKey = this.createStableInputKey(args);
      const existing = divergentByInput.get(inputKey);
      if (existing) {
        existing.failCount += 1;
        continue;
      }

      const impl1Code = validGenerations[0].trim();
      const impl2Code = validGenerations[1].trim();
      divergentByInput.set(inputKey, {
        input: args,
        impl1: {
          code: impl1Code,
          result: results[0]
        },
        impl2: {
          code: impl2Code,
          result: results[1]
        },
        failCount: 1
      });
    }

    report.divergentTests = Array.from(divergentByInput.values()).sort((a, b) => b.failCount - a.failCount);
    return report;
  }

  private createStableInputKey(input: unknown[]): string {
    return JSON.stringify(this.normalizeForStableKey(input));
  }

  private normalizeForStableKey(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeForStableKey(item));
    }

    if (value !== null && typeof value === 'object') {
      return Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = this.normalizeForStableKey((value as Record<string, unknown>)[key]);
          return acc;
        }, {});
    }

    return value;
  }
}

