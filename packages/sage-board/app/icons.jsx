const Svg = ({ children, className = "ico" }) => <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">{children}</svg>;

export const OverviewIcon = () => <Svg><rect x="2" y="2" width="5" height="5" rx="1" /><rect x="9" y="2" width="5" height="5" rx="1" /><rect x="2" y="9" width="5" height="5" rx="1" /><rect x="9" y="9" width="5" height="5" rx="1" /></Svg>;
export const TasksIcon = () => <Svg><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M5 8l2 2 4-4" /></Svg>;
export const AgentsIcon = () => <Svg><circle cx="8" cy="4" r="2" /><circle cx="3.5" cy="12" r="2" /><circle cx="12.5" cy="12" r="2" /><path d="M8 6v2M8 8l-3.5 2.5M8 8l3.5 2.5" /></Svg>;
export const PullsIcon = () => <Svg><circle cx="4" cy="3.5" r="1.5" /><circle cx="4" cy="12.5" r="1.5" /><circle cx="12" cy="12.5" r="1.5" /><path d="M4 5v6M12 11V6.5A2 2 0 0010 4.5H7.5M9 3l-1.5 1.5L9 6" /></Svg>;
export const StatsIcon = () => <Svg><path d="M2 14h12M4 12V8M8 12V3M12 12V6" /></Svg>;
export const LeafIcon = () => <Svg><path d="M3 13c0-6 4-10 10-10 0 6-4 10-10 10zM3 13l6-6" /></Svg>;
export const MoonIcon = () => <Svg><path d="M13 9.5A5.5 5.5 0 016.5 3 5.5 5.5 0 1013 9.5z" /></Svg>;
export const SunIcon = () => <Svg><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></Svg>;
export const AlertIcon = () => <Svg><path d="M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.01" /></Svg>;

export function StateIcon({ state }) {
  const filled = state === "done";
  return <svg className={`state ${state}`} viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M7 1l6 6-6 6-6-6z" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" /></svg>;
}

const GROUP_MARKS = {
  need: <><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.7M8 11v.01" /></>,
  review: <><circle cx="8" cy="8" r="6" /><path d="M8 4.8V8l2.2 1.4" /></>,
  repair: <path d="M10.6 2.2a3.2 3.2 0 00-3.3 4.4L2.4 11.5a1.5 1.5 0 002.1 2.1l4.9-4.9a3.2 3.2 0 004.4-3.3l-1.9 1.9-1.9-.3-.3-1.9z" />,
  build: <><rect x="2.5" y="8.5" width="11" height="5" rx="1" /><path d="M5 8.5v-3h6v3M8 5.5V2.5" /></>,
  ready: <><circle cx="8" cy="8" r="6" /><path d="M5.6 8.1l1.7 1.7 3.2-3.5" /></>,
  wait: <><circle cx="8" cy="8" r="6" /><path d="M6.5 5.6v4.8M9.5 5.6v4.8" /></>,
  merged: <><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="9" r="1.5" /><path d="M4.5 5v6M4.5 5c0 3 3 4 5.5 4" /></>,
};
export const GroupIcon = ({ group }) => <Svg className={`ico grp ${group}`}>{GROUP_MARKS[group]}</Svg>;
