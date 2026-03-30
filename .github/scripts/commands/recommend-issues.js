// SPDX-License-Identifier: Apache-2.0
//
// commands/recommend-issues.js
//
// Issue recommendation command: suggests relevant issues to contributors
// after a PR is closed. Uses skill progression logic to recommend the next
// suitable issues based on difficulty level.

const {
    MAINTAINER_TEAM,
    LABELS,
    hasLabel,
    postComment,
    getLogger,
} = require('../helpers');

// Difficulty hierarchy used to determine progression for recommendations
const SKILL_HIERARCHY = [
    LABELS.GOOD_FIRST_ISSUE,
    LABELS.BEGINNER,
    LABELS.INTERMEDIATE,
    LABELS.ADVANCED,
];

// Logger delegation 
const logger = {
    log: (...args) => getLogger().log(...args),
    error: (...args) => getLogger().error(...args),
};

/**
 * Returns the difficulty level of an issue based on its labels.
 *
 * Checks labels against SKILL_HIERARCHY and returns the first match.
 *
 * @param {{ labels: Array<string|{ name: string }> }} issue
 * @returns {string|null} Matching level or null if none found.
 */
function getIssueSkillLevel(issue) {
    for (const level of SKILL_HIERARCHY) {
        if (hasLabel(issue, level)) return level;
    }
    return null;
}

/**
 * Returns the next difficulty level in the hierarchy.
 *
 * @param {string} currentLevel
 * @returns {string|null} Next level, same level if max, or null if invalid.
 */
function getNextLevel(currentLevel) {
    const index = SKILL_HIERARCHY.indexOf(currentLevel);
    if (index === -1) return null;

    return SKILL_HIERARCHY[index + 1] || currentLevel;
}

/**
 * Returns the previous (fallback) difficulty level.
 *
 * @param {string} currentLevel
 * @returns {string|null} Lower level or null if none.
 */
function getFallbackLevel(currentLevel) {
    const index = SKILL_HIERARCHY.indexOf(currentLevel);
    if (index <= 0) return null;

    return SKILL_HIERARCHY[index - 1];
}

/**
 * Groups issues by their matching difficulty level.
 *
 * Each issue is assigned to the first matching level in levelsPriority.
 *
 * @param {Array<object>} issues
 * @param {string[]} levelsPriority
 * @returns {Object<string, Array<object>>} Issues grouped by level.
 */
function groupIssuesByLevel(issues, levelsPriority) {
    const grouped = Object.fromEntries(
        levelsPriority.map(level => [level, []])
    );

    for (const issue of issues) {
        const level = levelsPriority.find(l => hasLabel(issue, l));
        if (level) grouped[level].push(issue);
    }

    return grouped;
}

/**
 * Returns issues from the highest-priority level with results.
 *
 * Limits output to 5 issues.
 *
 * @param {Object<string, Array<object>>} grouped
 * @param {string[]} levelsPriority
 * @returns {Array<object>} Selected issues or empty array.
 */
function pickFirstAvailableLevel(grouped, levelsPriority) {
    for (const level of levelsPriority) {
        if (grouped[level].length > 0) {
            return grouped[level].slice(0, 5);
        }
    }
    return [];
}

/**
 * Fetches issues for multiple levels in a single query.
 *
 * @param {object} github
 * @param {string} owner
 * @param {string} repo
 * @param {string[]} levels
 * @returns {Promise<Array<{ title: string, html_url: string, labels: Array }> | null>}
 */
async function fetchIssuesBatch(github, owner, repo, levels) {
    try {
        const labelQuery = levels.map(l => `label:"${l}"`).join(' OR ');

        const query = [
            `repo:${owner}/${repo}`,
            'is:issue',
            'is:open',
            'no:assignee',
            `(${labelQuery})`,
            `label:"${LABELS.READY_FOR_DEV}"`
        ].join(' ');

        const result = await github.rest.search.issuesAndPullRequests({
            q: query,
            per_page: 10, // slightly higher since we filter later
        });

        return result.data.items || [];
    } catch (error) {
        logger.error('Failed to fetch issues:', {
            message: error.message,
            status: error.status,
        });
        return null;
    }
}

/**
 * Builds the success comment listing recommended issues.
 *
 * @param {string} username
 * @param {Array<{ title: string, html_url: string }>} issues
 * @returns {string}
 */
function buildRecommendationComment(username, issues) {
    const list = issues.map(
        (issue) => `- [${issue.title}](${issue.html_url})`
    );
    return [
        `👋 Hi @${username}! Great work on your recent contribution! 🎉`,
        '',
        `Here are some issues you might want to explore next:`,
        '',
        ...list,
        '',
        `Happy coding! 🚀`,
    ].join('\n');
}

/**
 * Builds an error comment when recommendations fail.
 *
 * @param {string} username
 * @returns {string}
 */
function buildRecommendationErrorComment(username) {
    return [
        `👋 Hi @${username}!`,
        '',
        `I ran into an issue while generating recommendations for you.`,
        '',
        `${MAINTAINER_TEAM} — could you please take a look?`,
        '',
        `Sorry for the inconvenience — feel free to explore open issues in the meantime!`,
    ].join('\n');
}

/**
 * Returns recommended issues based on priority:
 * next → same → fallback.
 *
 * Uses a single API call and filters results locally.
 *
 * @param {object} botContext
 * @param {string} username
 * @param {string} skillLevel
 * @param {{ hasErrored: boolean }} errorState
 * @returns {Promise<Array<{ title: string, html_url: string }>|null>}
 */
async function getRecommendedIssues(botContext, username, skillLevel, errorState) {
    const fallback = getFallbackLevel(skillLevel);

    const levelsPriority = [
        getNextLevel(skillLevel),
        skillLevel,
        skillLevel !== LABELS.BEGINNER ? fallback : null,
    ].filter(Boolean);

    const issues = await fetchIssuesBatch(
        botContext.github,
        botContext.owner,
        botContext.repo,
        levelsPriority
    );

    if (issues === null) {
        if (!errorState.hasErrored) {
            await postComment(
                botContext,
                buildRecommendationErrorComment(username)
            );
            errorState.hasErrored = true;
        }
        return null;
    }

    const grouped = groupIssuesByLevel(issues, levelsPriority);
    return pickFirstAvailableLevel(grouped, levelsPriority);
}

/**
 * Main handler for issue recommendations after a PR is merged.
 *
 * - Determines skill level
 * - Fetches recommended issues
 * - Posts a comment if results exist
 *
 * Skips silently if context is incomplete or no results found.
 * Returns early on API failure (error comment handled upstream).
 *
 * @param {{
 *   github: object,
 *   owner: string,
 *   repo: string,
 *   issue: object,
 *   sender: { login: string }
 * }} botContext
 * @returns {Promise<void>}
 */
async function handleRecommendIssues(botContext) {
    const username = botContext.sender?.login;
    if (!username) {
        logger.log('Missing sender login, skipping recommendation');
        return;
    }

    if (!botContext.issue) {
        logger.log('Missing issue in context, skipping recommendation');
        return;
    }

    const skillLevel = getIssueSkillLevel(botContext.issue);
    if (!skillLevel) {
        logger.log('No skill level found, skipping recommendation', {
            issueNumber: botContext.issue?.number,
        });
        return;
    }

    logger.log('recommendation.context', {
        user: username,
        level: skillLevel,
        issue: botContext.issue?.number,
    });

    const errorState = { hasErrored: false };

    const issues = await getRecommendedIssues(
        botContext,
        username,
        skillLevel,
        errorState
    );

    if (issues === null) return;

    if (issues.length === 0) {
        logger.log('recommendation.empty', { user: username });
        return;
    }

    const comment = buildRecommendationComment(username, issues);
    logger.log('recommendation.postComment', {
        target: botContext.number,
        issueSource: botContext.issue?.number,
        recommendations: issues.length,
    });
    const result = await postComment(botContext, comment);

    if (!result.success) {
        logger.error('recommendation.postCommentFailed', {
            error: result.error,
        });
        return;
    }

    logger.log('recommendation.posted');
}

module.exports = { handleRecommendIssues };
