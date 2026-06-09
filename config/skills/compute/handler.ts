import { getTreasury, type SkillHandler } from "yappr";

export const handler: SkillHandler = async (_params, _tweet) => {
  await getTreasury().extendCompute();
  return { text: `compute extended by 24h` };
};
