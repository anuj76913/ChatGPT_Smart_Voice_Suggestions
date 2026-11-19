import { describe, expect, it } from 'vitest';
import { isCoachEcho } from '../src/voice/echo';

const coach =
  "You've turned the question back on me; next time, give your own concrete suggestions first. For a campus food-delivery service I'd prioritize: 1) a pick-up at restaurant option, 2) dynamic routing with batch deliveries, and 3) a limited-time free-delivery incentive for low-traffic periods to smooth demand. Why do you think those would work?";

describe('coach echo guard', () => {
  it('drops a transcript that is the coach’s own last sentence (the bug report)', () => {
    expect(isCoachEcho('And three, a limited time free delivery incentive for low traffic periods to smooth demand. Why do you think those would work?', coach)).toBe(true);
  });
  it('drops a short echoed fragment', () => {
    expect(isCoachEcho('why do you think those would work', coach)).toBe(true);
  });
  it('keeps a real answer, even one that repeats the question', () => {
    expect(isCoachEcho('Why do you think those would work? Because pick-up cuts the delivery load at peak hours and batching lets one rider carry four orders.', coach)).toBe(false);
    expect(isCoachEcho('I think batching works because students order at the same times, so one trip can serve a whole hostel.', coach)).toBe(false);
  });
  it('keeps short answers and handles a missing coach turn', () => {
    expect(isCoachEcho('Yes, I agree.', coach)).toBe(false);
    expect(isCoachEcho('a limited time free delivery incentive', undefined)).toBe(false);
  });
});
