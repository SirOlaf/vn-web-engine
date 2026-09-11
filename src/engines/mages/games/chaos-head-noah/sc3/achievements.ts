import {StoredAchievements} from '../../../../../platform/achievements.js';

/** Noah's 140063410/1400634e0 and the 26 branch of 140047f50.
 * Completion rules belong to the game, not the platform achievement store. */
export function awardNoahAchievement(host: StoredAchievements, id: number): void {
  const unlock = (index: number): void => {
    if (!host.store) return; // Native manager is not ready without the platform service.
    if (index < 0 || index >= 34 || !Number.isInteger(index))
      throw new Error(`Invalid Noah achievement ${index}`);
    const fresh = !host.has(index);
    host.unlock(index);
    if (fresh && index !== 0 && Array.from({length: 33}, (_, i) => i + 1).every((i) => host.has(i)))
      unlock(0);
  };
  unlock(id);
  if (id !== 26 && Array.from({length: 9}, (_, i) => i + 17).every((i) => host.has(i))) unlock(26);
}
