// The empty state — slide 1.
//
// One face, one line, one input. Everything the working shell carries (rail,
// summaries, sidebar) is absent because there is nothing yet to navigate: a
// tab strip over an empty canvas is chrome advertising rooms that are all
// empty.
//
// Forecast's bunny greets, because the forecast is what the empty state is
// asking for: describe a community and the W(M,T,R) trajectory is the first
// thing produced. Every other surface is a reaction to it.

import { Pet } from './Pet';

/** Time-of-day greeting. Nothing turns on it; it just stops the empty state
 *  reading identically at 3am and 3pm. */
function greetingFor(hour: number): string {
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function Greeting({ hour = new Date().getHours() }: { hour?: number }) {
  return (
    <div className="greeting">
      {/* Happy to see you, follows the cursor, and twirls if poked. */}
      <Pet kind="bunny" className="greeting-face" mood="happy" playful reach={2.5} />
      <div className="greeting-line">{greetingFor(hour)}</div>
    </div>
  );
}
