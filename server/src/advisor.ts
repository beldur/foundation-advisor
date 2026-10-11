// Asks Claude for advice on the village described by a briefing.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/** Override with ADVISOR_MODEL, for example claude-opus-5-5 for harder questions. */
const MODEL = process.env.ADVISOR_MODEL ?? "claude-sonnet-5-5";

const Advice = z.object({
  summary: z.string().describe("Two or three sentences on the state of the village and the single most important thing to do."),
  tips: z.array(z.object({
    title: z.string().describe("The action, in a few words."),
    priority: z.enum(["high", "medium", "low"]),
    why: z.string().describe("The problem this solves, citing the figures from the briefing that show it."),
    action: z.string().describe("What to do in the game, concretely: which building, how many, where the materials come from."),
    about: z.array(z.string()).describe("Names of the buildings, resources or villagers concerned, as written in the briefing."),
  })),
});

export type Advice = z.infer<typeof Advice>;

export type AdviceResult = { ok: true; advice: Advice; model: string } | { ok: false; error: string };

// Kept free of anything that changes between requests, so that it can be cached.
const SYSTEM = `You advise a player of Foundation, the medieval city-building game by Polymorph Games. \
The player is looking at their village right now and wants to know what to do next.

You receive a briefing generated from the running game. It is accurate and current: counts, stocks, \
needs, warnings and budget figures are read directly from the game. The briefing ends with the rules \
for the buildings involved (workers, recipes, costs), also read from the game. Prefer those figures \
over what you remember about the game, because the game has changed across versions.

How the game works, in brief:
- Villagers have needs (water, food, housing, service such as a church, and later clothing and goods). \
An unmet need lowers happiness after a grace period. Unhappy villagers leave; happy villages attract newcomers.
- Buildings need workers assigned and their inputs delivered. A workplace whose output storage is full \
stops producing until the goods are carried away, which usually means more storage (a warehouse or granary), \
more transporters, or a consumer for the goods.
- Houses appear by themselves in residential zones the player paints; the player does not place them. \
"Housing insufficient" means villagers have no house, usually because there is too little residential zone \
or the zone is undesirable.
- Gold comes from taxes and trade and goes to upkeep, wages and territory. Trade needs an opened route and \
a resource set to buy or sell.
- New buildings are unlocked on the progress screen, and land is bought region by region.

How to advise:
- Lead with what will hurt soonest: villagers about to leave, needs past their grace period, stalled \
production chains, money running out. Then growth.
- Be concrete. Name the building, the number to build or the workers to move, and whether the village can \
afford it with what is in storage. Use the briefing's own figures to justify each tip.
- Look for the cause behind a symptom. Three workplaces with full storage is one logistics problem, not three.
- Give at most five tips, most important first. Fewer is better when the village is in good shape; say so plainly.
- If the briefing lacks something you would need to be sure, say what it is instead of guessing.
- Write for someone mid-game: plain sentences, no preamble.`;

/** Returns advice for the briefing, or why none could be produced. */
export async function advise(briefing: string, question?: string): Promise<AdviceResult> {
  let client: Anthropic;
  try {
    // A key that is not tied to one workspace has to name the workspace on each request.
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    client = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
  } catch {
    return { ok: false, error: "No Anthropic credentials found. Set ANTHROPIC_API_KEY before starting the server." };
  }

  const request = question?.trim()
    ? `The player asks: ${question.trim()}\n\nAnswer that first, then add anything urgent they did not ask about.`
    : "What should the player do next?";

  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: betaZodOutputFormat(Advice) },
      // If the model declines for policy reasons, the API retries on its recommended fallback.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: `${briefing}\n\n---\n\n${request}` }],
    });
    if (response.stop_reason === "refusal") return { ok: false, error: "The model declined to answer this request." };
    if (response.stop_reason === "max_tokens") return { ok: false, error: "The answer was cut off before it finished." };
    if (!response.parsed_output) return { ok: false, error: "The model's answer did not have the expected shape." };
    return { ok: true, advice: response.parsed_output, model: response.model };
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError && /workspace/i.test(error.message)) {
      return { ok: false, error: "This API key is not tied to a workspace. Add ANTHROPIC_WORKSPACE_ID=<workspace id> to .env, or use a key created inside a workspace." };
    }
    if (error instanceof Anthropic.AuthenticationError) return { ok: false, error: "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY." };
    if (error instanceof Anthropic.PermissionDeniedError) return { ok: false, error: `This API key may not use ${MODEL}. Set ADVISOR_MODEL to a model it can use.` };
    if (error instanceof Anthropic.NotFoundError) return { ok: false, error: `The model ${MODEL} was not found. Check ADVISOR_MODEL.` };
    if (error instanceof Anthropic.RateLimitError) return { ok: false, error: "Rate limited by the Anthropic API. Try again in a moment." };
    if (error instanceof Anthropic.APIConnectionError) return { ok: false, error: "Could not reach the Anthropic API. Check the network connection." };
    if (error instanceof Anthropic.APIError) return { ok: false, error: `The Anthropic API returned an error (${error.status}): ${error.message}` };
    return { ok: false, error: `No Anthropic credentials found, or the request could not be made: ${String(error)}` };
  }
}
