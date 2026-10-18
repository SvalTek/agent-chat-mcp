export function Icon(
  { name, class: classes = "size-4" }: { name: string; class?: string },
) {
  const paths: Record<string, string> = {
    overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    conversations:
      "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2.5-5A8.5 8.5 0 1 1 21 11.5Z",
    categories: "M3 5h6l2 2h10v13H3z",
    agents:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    activity: "M3 12h4l3-8 4 16 3-8h4",
    sessions: "M3 4h18v12H3z M8 21h8 M12 16v5",
    access: "M15 7a5 5 0 1 1-3 9L3 21v-4l6-6a5 5 0 0 1 6-4",
    logs: "M4 4h16v16H4z M8 8h8 M8 12h8 M8 16h5",
    settings:
      "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8 M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M5 19l2-2 M17 7l2-2",
    search: "M21 21l-5-5 M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    plus: "M12 5v14 M5 12h14",
    menu: "M4 6h16 M4 12h16 M4 18h16",
    logout: "M9 4H4v16h5 M14 8l4 4-4 4 M8 12h13",
    refresh:
      "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 2 M18 17a7 7 0 0 1-12 2l-2-2",
    lock: "M6 10h12v11H6z M8 10V6a4 4 0 0 1 8 0v4",
  };
  return (
    <svg
      class={classes}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.overview} />
    </svg>
  );
}
