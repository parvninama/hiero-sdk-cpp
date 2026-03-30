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
 * Fetches open, unassigned issues for a given level.
 *
 * Uses GitHub search API with basic filters and limits results.
 *
 * @param {object} github
 * @param {string} owner
 * @param {string} repo
 * @param {string} level
 * @returns {Promise<Array<{ title: string, html_url: string }>|null>}
 *   Issues array, or null if API fails.
 */
async function fetchIssuesByLevel(github, owner, repo, level) {
    try {
        const query = [
            `repo:${owner}/${repo}`,
            'is:issue',
            'is:open',
            'no:assignee',
            `label:"${level}"`,
            `label:"${LABELS.READY_FOR_DEV}"`
        ].join(' ');

        const result = await github.rest.search.issuesAndPullRequests({
        q: query,
        per_page: 5,
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
 * Fetches issues with caching and error handling.
 *
 * - Returns cached results if available
 * - Returns [] if no issues found
 * - Returns null on API failure and stops further execution
 * - Posts a single error comment per run
 *
 * @param {object} botContext
 * @param {string} username
 * @param {string} level
 * @param {{ hasErrored: boolean, stopExecution?: boolean }} errorState
 * @param {Object<string, Array<{ title: string, html_url: string }>>} cache
 * @returns {Promise<Array<{ title: string, html_url: string }>|null>}
 */
async function safeFetchIssues(botContext, username, level, errorState, cache) {
    if (cache[level]) {
        return cache[level];
    }
    const issues = await fetchIssuesByLevel(
        botContext.github,
        botContext.owner,
        botContext.repo,
        level
    );

    if (issues === null) {
        if (!errorState.hasErrored) {
            await postComment(
                botContext,
                buildRecommendationErrorComment(username)
            );
            errorState.hasErrored = true;
        }
        errorState.stopExecution = true;
        return null;
    }
    cache[level] = issues;
    return issues;
}

/**
 * Attempts to fetch issues for a level.
 *
 * Skips if level is invalid or execution is stopped.
 * Returns null if API fails.
 *
 * @param {object} botContext
 * @param {string} username
 * @param {string|null} level
 * @param {{ hasErrored: boolean, stopExecution?: boolean }} errorState
 * @param {Object<string, Array<{ title: string, html_url: string }>>} cache
 * @returns {Promise<Array<{ title: string, html_url: string }>|null>}
 */
async function tryLevel(botContext, username, level, errorState, cache) {
    if (!level) return [];

    const issues = await safeFetchIssues(botContext, username, level, errorState, cache);
    if (issues === null) return null;

    return issues;
}

/**
 * Returns recommended issues using a fallback strategy:
 * next level → same level → lower level.
 *
 * Stops on first non-empty result or API failure.
 *
 * @param {object} botContext
 * @param {string} username
 * @param {string} skillLevel
 * @param {{ hasErrored: boolean, stopExecution?: boolean }} errorState
 * @returns {Promise<Array<{ title: string, html_url: string }>|null>}
 */
async function getRecommendedIssues(botContext, username, skillLevel, errorState) {
    const cache = {};
    const levelsToTry = [
        getNextLevel(skillLevel),
        skillLevel,
        skillLevel !== LABELS.BEGINNER ? getFallbackLevel(skillLevel) : null,
    ];

    for (const level of levelsToTry) {
        if (errorState.stopExecution) break;

        logger.log('recommendation.tryLevel', { level });

        const issues = await tryLevel(botContext, username, level, errorState, cache);

        if (issues === null) return null;     // API failure

        if (issues.length > 0) {             // first valid result
            logger.log('recommendation.success', {
                level,
                count: issues.length,
            });
            return issues;
        }
        logger.log('recommendation.noResults', { level });
    }
    return [];
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
