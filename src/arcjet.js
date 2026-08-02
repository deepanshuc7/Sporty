import "dotenv/config";
import arcjet, {detectBot, shield, slidingWindow} from "@arcjet/node";
import { isSpoofedBot } from "@arcjet/inspect";

const arcjetKey = process.env.ARCJET_KEY;
export const arcjetMode = process.env.ARCJET_ENV === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE';

if(!arcjetKey) throw new Error('ARCJET_KEY environment variable is missing');

export const httpArcjet = arcjetKey ? arcjet({
    key: arcjetKey,
    rules: [
        shield({mode: arcjetMode}),
        detectBot({mode: arcjetMode, allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW'],}),
        slidingWindow({mode: arcjetMode, interval: '10s', max: 50})
    ]
}) : null;

export const wsArcjet = arcjetKey ? arcjet({
    key: arcjetKey,
    rules: [
        shield({mode: arcjetMode}),
        detectBot({mode: arcjetMode, allow: ['CATEGORY:SEARCH_ENGINE', 'CATEGORY:PREVIEW'],}),
        slidingWindow({mode: arcjetMode, interval: '2s', max: 5})
    ]
}) : null;

export function securityMiddleware() {
    return async (req, res, next) => {
        if(!httpArcjet) return next();

        try {
            const decision = await httpArcjet.protect(req);

            if(decision.isErrored()) {
                console.error('Arcjet decision error:', decision.reason.message);
                // Arcjet decision errors fail open unless this application explicitly opts into fail-closed behavior.
            } else {
                const spoofedBot = decision.results.some(isSpoofedBot);

                if(spoofedBot) {
                    if(arcjetMode === 'LIVE') {
                        return res.status(403).json({error: 'Forbidden.'});
                    }

                    console.warn('Arcjet detected a spoofed bot in DRY_RUN mode');
                }

                if(decision.isDenied() && !(spoofedBot && arcjetMode === 'DRY_RUN')) {
                    if(decision.reason.isRateLimit()) {
                        return res.status(429).json({error: 'Too many requests'});
                    }

                    return res.status(403).json({error: 'Forbidden.'});
                }
            }
        } catch (error) {
            console.error('Arcjet middleware error', error);
            return res.status(503).json({error: 'Service Unavailable'});
        }

        next();
    }
}
