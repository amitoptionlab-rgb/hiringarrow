// Checks the optional "connect your own model" path against scripts/mock-ai.mjs.
// Run: AI_BASE_URL=http://127.0.0.1:4010/v1 node scripts/llm-test.mjs   (with `node scripts/mock-ai.mjs` running)
const { askLlm } = await import('../src/ai.js');
const a = await askLlm('TASK:subjects', 'x');
let down = false; try { process.env.X = '1'; const { config } = await import('../src/config.js'); config.ai.baseUrl = 'http://127.0.0.1:9/v1'; await askLlm('TASK:subjects', 'x'); } catch { down = true; }
const ok = a.subjects?.length === 5 && down;
console.log(`${ok ? 'PASS' : 'FAIL'}  optional model: answers parsed (${a.subjects?.length} subjects), unreachable model throws so the built-in helper takes over`);
process.exit(ok ? 0 : 1);
