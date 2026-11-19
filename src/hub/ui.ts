// The icons the Liv window is drawn with. Same look as the Mac's (FlowHub.swift).

/** Stroke icons on a 24×24 grid, standing in for the Mac's SF Symbols. */
export const HUB_ICONS: Record<string, string> = {
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  shapes: "M4.5 8.5a4 4 0 0 1 4-4h7a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4h-7a4 4 0 0 1-4-4zM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7",
  grid: "M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z",
  terminal: "M3.5 5.5h17v13h-17zM7 10l3 2.5L7 15M12.5 15H17",
  chat: "M4 5.5h16v10H10l-4 3.5v-3.5H4z",
  puzzle: "M9 4h4v2a1.8 1.8 0 1 0 3.6 0V4H20v5.5h-2a1.8 1.8 0 1 0 0 3.6h2V20h-5.5v-2a1.8 1.8 0 1 0-3.6 0v2H4v-6.4h2a1.8 1.8 0 1 0 0-3.6H4V4h5z",
  keyboard: "M3 6.5h18v11H3zM6.5 10h1M10 10h1M13.5 10h1M17 10h.5M7 14h10",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  search: "M10.5 3a7.5 7.5 0 0 1 5.96 12.06l4.24 4.24-1.4 1.4-4.24-4.24A7.5 7.5 0 1 1 10.5 3zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z",
};

export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", HUB_ICONS[name] ?? "");
  svg.append(path);
  return svg;
}
