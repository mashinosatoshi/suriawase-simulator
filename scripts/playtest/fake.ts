// --dry-run 用の作り物の AI。API を呼ばずに、試遊の仕組み (進行・記録・レポート) だけを確かめる。
// GM は決まったシナリオと決まった台詞、プレイヤー役は決まった発言、審査役は決まった指摘を返す
import type { AssistantTurn, ChatSession, LlmProvider, SessionOptions, TurnInput } from "../../src/llm/index.js";
import type { JudgeReport } from "./judge.js";

const SCENARIO = {
  title: "橋の場所",
  premise: "川に新しい橋をかけたい。村長と場所について話し合う。",
  player_role: "隣村から来た調停役",
  goal: "橋の建設場所について村長と合意する",
  characters: [
    {
      id: "mayor",
      name: "村長",
      emoji: "👴",
      role: "村長",
      persona: "慎重で面倒見がよい。決めつけられるのを嫌う。",
      trust_start: 5,
      openness: 5,
      understanding: 5,
      speech: "一人称は「わし」、相手は「あんた」。老人らしいくだけた口調。",
      sample_lines: ["そうさのう、費用のことは気になるわい。", "あんたの話は、よう分かった。"],
    },
  ],
  concerns: [
    { id: "c1", owner: "mayor", category: "予算", text: "村の蓄えが少なく大きな橋は作れない", importance: 9, reveal_hint: "費用を尋ねる", min_trust: 1, resolved_when: "村の予算内に収まる規模の案が示される" },
    { id: "c2", owner: "mayor", category: "行事", text: "祭りの行列の道筋が変わってしまう", importance: 6, reveal_hint: "行事を尋ねる", min_trust: 4, resolved_when: "祭りの行列の経路が確保される" },
    { id: "c3", owner: "mayor", category: "仕事", text: "渡し守の仕事がなくなる", importance: 5, reveal_hint: "渡し守に触れる", min_trust: 6, resolved_when: "渡し守の役割が守られる案が示される" },
    { id: "c4", owner: "mayor", category: "安全", text: "子どもが橋から川へ落ちないか心配だ", importance: 4, reveal_hint: "安全のことを尋ねる", min_trust: 7, resolved_when: "子どもを守る備えが示される" },
    { id: "c5", owner: "mayor", category: "工事", text: "工事のあいだ畑への道がふさがる", importance: 3, reveal_hint: "工事の段取りを尋ねる", min_trust: 8, resolved_when: "工事中の迂回路が示される" },
  ],
  root_issue: {
    owner: "mayor",
    text: "村の若い担い手が減り、村の暮らしや祭りをこの先も続けられるかが不安だ",
    linked: ["c1", "c2", "c3"],
    cascade: [
      { id: "c1", how: "担い手の不安が晴れ、村の将来の見通しが立てば、大きな橋にこだわらず、予算内の小さな橋を受け入れられる" },
      { id: "c2", how: "村の暮らしを続ける手応えがあれば、祭りの行列の道筋が変わることも、受け入れやすくなる" },
      { id: "c3", how: "村に人が残る見通しがあれば、渡し守の仕事の形が変わることにも、前向きに向き合える" },
    ],
    awareness: "unaware",
    reach_when: "村の担い手が減っていることと、橋の場所へのこだわりがその不安の表れであることを言い当てる",
  },
  briefing: [
    { label: "計画", text: "県の補助で、来年度中に川へ橋を 1 本かける" },
    { label: "候補地", text: "東の浅瀬と、村の中心に近い西の渡し場の 2 か所" },
    { label: "これまで", text: "村の寄合で 2 回話し合ったが、場所が決まっていない" },
  ],
  opening: [{ speaker: "mayor", text: "橋なら東の浅瀬がよかろう。" }],
};

const MAYOR_LINES = ["そうさのう、もう少し聞かせてくれんか。", "あんたの言うことも分からんではない。", "わしも村のことを考えておるんじゃ。"];
const PLAYER_LINES = ["橋の費用は、どのくらいを考えていますか。", "村の皆さんの暮らしで、気がかりなことはありますか。", "西の渡し場には、どんな思い出がありますか。"];

let seq = 0;
const call = (name: string, input: unknown): AssistantTurn => ({ toolCalls: [{ id: `fake${++seq}`, name, input }], text: "" });

/** GM: 届いた仕事 (文の最後の行の JSON) に合わせて、ツールを呼ぶ */
class FakeGmSession implements ChatSession {
  async next(input: TurnInput): Promise<AssistantTurn> {
    const text = input.text ?? "";
    const work = JSON.parse(text.slice(text.lastIndexOf("\n") + 1)) as { type: string; turn?: number; defer?: boolean; final_turn?: boolean; concerns?: Array<{ id: string; status: string }> };
    if (work.type === "new_game") return call("start_scenario", SCENARIO);
    if (work.type === "player_action") {
      const ending = work.defer || work.final_turn ? { epilogue: "二人は、続きをまた話すことにした。" } : {};
      return call("reply", { turn: work.turn, lines: [{ speaker: "mayor", text: MAYOR_LINES[(work.turn ?? 0) % MAYOR_LINES.length] }], ...ending });
    }
    const unresolved = (work.concerns ?? []).filter((c) => c.status !== "resolved");
    return call("submit_review", {
      overall: "作り物の振り返りです (dry-run)。",
      good: ["相手の事情を尋ねていました。"],
      improve: ["具体的な案を出してみましょう。"],
      concerns: unresolved.map((c) => ({ id: c.id, advice: "作り物の助言です (dry-run)。" })),
    });
  }
}

let playerTurn = 0;
class FakePlayerSession implements ChatSession {
  async next(): Promise<AssistantTurn> {
    return call("say", { text: PLAYER_LINES[playerTurn++ % PLAYER_LINES.length] });
  }
}

const FAKE_REPORT: JudgeReport = {
  naturalness: 4,
  summary: "作り物の審査です (dry-run)。",
  issues: [{ turn: 1, speaker: "村長", quote: "もう少し聞かせてくれんか", category: "その他", severity: "軽微", reason: "作り物の指摘です (dry-run)。" }],
  root_issue: { depth: 3, cascade: 3, reach: "言い当ての試みなし", comment: "作り物の評価です (dry-run)。" },
};
class FakeJudgeSession implements ChatSession {
  async next(): Promise<AssistantTurn> {
    return call("report", FAKE_REPORT);
  }
}

export const fakeProvider = (role: "gm" | "player" | "judge"): LlmProvider => ({
  id: "anthropic",
  newSession: (_o: SessionOptions) => (role === "gm" ? new FakeGmSession() : role === "player" ? new FakePlayerSession() : new FakeJudgeSession()),
});
