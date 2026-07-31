import { MATCH_STATUS } from '../validation/matches.js';

export function getMatchStatus(startTime, endTime, now = new Date()) {
    const start = new Date(startTime);
    const end = endTime == null ? null : new Date(endTime);

    if (Number.isNaN(start.getTime()) || (end && Number.isNaN(end.getTime()))) {
        return null;
    }

    if (now < start) {
        return MATCH_STATUS.SCHEDULED;
    }

    if (end && now >= end) {
        return MATCH_STATUS.FINISHED;
    }

    return MATCH_STATUS.LIVE;
}

export async function syncMatchStatus(match, updateStatus) {
    const nextStatus = getMatchStatus(match.startTime, match.endTime);
    if (!nextStatus) {
        return match.status;
    }
    if (match.status !== nextStatus) {
        await updateStatus(nextStatus);
        match.status = nextStatus;
    }
    return match.status;
}
