declare module "node-llama-cpp" {
  export function getLlama(options?: any): Promise<any>;
  export class LlamaChatSession {
    constructor(options: any);
  }
}
