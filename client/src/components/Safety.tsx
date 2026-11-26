import { block, report, unblock, useBlocked } from "../safety";

/** The Block / Unblock and Report links under someone's profile. */
export function SafetyLinks({ userId, name, before }: { userId: string; name: string; before?: () => void }) {
  const blocked = useBlocked(userId);
  return (
    <div className="profile-safety">
      {blocked ? (
        <button className="btn link small" onClick={() => unblock(userId, name)}>
          Unblock
        </button>
      ) : (
        <button className="btn link small danger-text" onClick={() => (before?.(), block(userId, name))}>
          Block
        </button>
      )}
      <button className="btn link small danger-text" onClick={() => (before?.(), report(userId))}>
        Report
      </button>
    </div>
  );
}
