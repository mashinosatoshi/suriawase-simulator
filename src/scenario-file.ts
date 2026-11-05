// シナリオのファイル (書き出し・読み込み)。いま遊んでいるシナリオを JSON にして保存し、別の人が同じシナリオで遊べるようにする。
// ファイルに入れるのは、シナリオそのもの (隠れた本音・解消条件などの隠し情報を含む) と、それが作られた難易度とパラメータだけ。
// 会話・信頼度・懸念の進み具合・結果・スコアは含めない (プレイの結果とは切り離す)。
// 読み込むファイルは、知らない人が作ったものかもしれない。AI が作ったシナリオと同じ検査に通し、通らなければ何も変えずに理由を返す
import { difficultyBrief, parseExactDifficulty } from "./difficulty.js";
import { checkScenario, scenarioSchema, type Scenario } from "./scenario.js";
import { findSecretLike, secretInTextMessage, type Difficulty, type DifficultyParams } from "./shared.js";

export const SCENARIO_FILE_FORMAT = "suriawase-simulator/scenario";
export const SCENARIO_FILE_VERSION = 1;
/** 読み込めるファイルの大きさ (文字数)。ふつうのシナリオは 1 万文字ほど */
export const MAX_SCENARIO_FILE_CHARS = 300_000;

export interface ScenarioFile {
  format: typeof SCENARIO_FILE_FORMAT;
  version: typeof SCENARIO_FILE_VERSION;
  /** このシナリオが作られた難易度とパラメータ。シナリオの検査 (本音の数・最初から話せる数など) はこれに結びつく */
  difficulty: Difficulty;
  params: DifficultyParams;
  scenario: Scenario;
}

export type ScenarioFileResult = { ok: true; file: ScenarioFile } | { ok: false; errors: string[] };

const fail = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });

/** 読み込んだ JSON を確かめる。AI が作ったシナリオと同じ検査 (形・数・誘導や URL・キーらしい文字列) に通す */
export function parseScenarioFile(input: unknown): ScenarioFileResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("シナリオのファイルの形式が正しくありません (JSON のオブジェクトではありません)");
  const f = input as Record<string, unknown>;
  if (f.format !== SCENARIO_FILE_FORMAT) return fail("すり合わせシミュレーターのシナリオのファイルではありません (format が違います)");
  if (f.version !== SCENARIO_FILE_VERSION) {
    return fail(typeof f.version === "number" && f.version > SCENARIO_FILE_VERSION ? "新しい版のシナリオのファイルです。アプリを最新にしてから読み込んでください" : "対応していない版のシナリオのファイルです");
  }
  if (JSON.stringify(input).length > MAX_SCENARIO_FILE_CHARS) return fail("シナリオのファイルが大きすぎます");

  const d = parseExactDifficulty(f.difficulty, f.params);
  if ("error" in d) return fail(d.error);
  const parsed = scenarioSchema.safeParse(f.scenario);
  if (!parsed.success) return fail(...parsed.error.issues.map((i) => `scenario.${i.path.join(".") || "(root)"}: ${i.message}`));
  const errors = checkScenario(parsed.data, difficultyBrief(d.level, d.params));
  // 誤って貼り付けられたキーが入っていないか (そのまま AI の会社に送られてしまう)
  const secret = findSecretLike(JSON.stringify(parsed.data));
  if (secret) errors.push(secretInTextMessage(secret));
  if (errors.length) return fail(...errors);
  return { ok: true, file: { format: SCENARIO_FILE_FORMAT, version: SCENARIO_FILE_VERSION, difficulty: d.level, params: d.params, scenario: parsed.data } };
}

/** 検査の理由を、画面に出せる文にする (多いときは先頭だけ) */
export function describeFileErrors(errors: string[], max = 6) {
  const shown = errors.slice(0, max).join("\n");
  return errors.length > max ? `${shown}\n…ほか ${errors.length - max} 件` : shown;
}
