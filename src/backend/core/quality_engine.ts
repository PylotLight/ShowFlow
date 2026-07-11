import { db } from '../db';

export interface ReleaseScore {
  rank: number;
  formatScore: number;
  totalScore: number;
  qualityId?: string;
}

export class QualityEngine {
  /**
   * Detects the quality of a release based on its filename.
   * Returns the rank and the quality ID if found.
   */
  detectQuality(filename: string): { rank: number; qualityId?: string } {
    const qualities = db.listQualities();
    let bestRank = 0;
    let bestId: string | undefined;

    for (const q of qualities) {
      // Simple case-insensitive inclusion check. 
      // In a real system, we might use regexes or aliases.
      if (filename.toLowerCase().includes(q.name.toLowerCase())) {
        if (q.rank > bestRank) {
          bestRank = q.rank;
          bestId = q.id;
        }
      }
    }

    return { rank: bestRank, qualityId: bestId };
  }

  /**
   * Calculates the sum of scores for custom formats that match the filename
   * and are associated with the given profile.
   */
  calculateFormatScore(filename: string, profileId: string): { score: number, isForbidden: boolean, missingRequired: string[] } {
    const formats = db.getProfileFormats(profileId);
    console.log(`[QualityEngine] Formats for ${profileId}:`, formats);
    let totalScore = 0;
    const missingRequired: string[] = [];

    for (const f of formats) {
      const regex = new RegExp(f.regex, 'i');
      const matches = regex.test(filename);

      if (f.profile_format_type === 'forbidden' && matches) {
        console.log(`[QualityEngine] Forbidden match: ${f.name}`);
        return { score: 0, isForbidden: true, missingRequired: [] };
      }

      if (f.profile_format_type === 'required' && !matches) {
        console.log(`[QualityEngine] Missing required: ${f.name}`);
        missingRequired.push(f.name);
      }

      if (f.profile_format_type === 'bonus' && matches) {
        console.log(`[QualityEngine] Bonus match: ${f.name} (+${f.score})`);
        totalScore += f.score;
      }
    }

    return { 
      score: totalScore, 
      isForbidden: false, 
      missingRequired 
    };
  }

  /**
   * Returns a comprehensive score for a release.
   */
  getReleaseScore(filename: string, profileId: string): ReleaseScore {
    const { rank, qualityId } = this.detectQuality(filename);
    const formatResult = this.calculateFormatScore(filename, profileId);
    
    if (formatResult.isForbidden) {
      return { rank: 0, formatScore: -1, totalScore: -1, qualityId: undefined };
    }

    // Total score is weighted: Rank is primary, FormatScore is a tie-breaker/bonus.
    const totalScore = (rank * 1000) + formatResult.score;

    return {
      rank,
      formatScore: formatResult.score,
      totalScore,
      qualityId
    };
  }

  /**
   * Compares two files to determine if the new one is an upgrade.
   */
  shouldUpgrade(existingFilename: string, newFilename: string, profileId: string): boolean {
    const existing = this.getReleaseScore(existingFilename, profileId);
    const newcomer = this.getReleaseScore(newFilename, profileId);
    
    return newcomer.totalScore > existing.totalScore;
  }
}

export const qualityEngine = new QualityEngine();
