import OpenAI from "openai";

/**
 * Returns an OpenAI-compatible client.
 * Priority: 0G Compute (ZEROG_COMPUTE_ENDPOINT) → OpenAI (OPENAI_API_KEY).
 */
export function createLLMClient(): OpenAI {
  const endpoint = process.env.ZEROG_COMPUTE_ENDPOINT?.trim();
  const zerogKey = process.env.ZEROG_COMPUTE_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  if (endpoint) {
    return new OpenAI({
      baseURL: endpoint,
      apiKey: zerogKey ?? openaiKey ?? "placeholder",
    });
  }
  if (!openaiKey) {
    throw new Error(
      "No LLM backend configured: set ZEROG_COMPUTE_ENDPOINT or OPENAI_API_KEY"
    );
  }
  return new OpenAI({ apiKey: openaiKey });
}

export const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";
