export type ThemeTokens = {
  bg: string;
  text: string;
  accent: string;
};

export type TypographyTokens = {
  fontFamily: string;
  scale: number;
};

export type LayoutTokens = {
  alignment: "left" | "center";
  heroVariant: "split" | "stacked" | "minimal";
};

export type CopySlot = "headline" | "subheadline" | "cta" | "body";

export type FeatureCard = {
  title: string;
  body: string;
};

export type SiteState = {
  theme: ThemeTokens;
  typography: TypographyTokens;
  layout: LayoutTokens;
  copy: Record<CopySlot, string>;
  features: FeatureCard[];
};

const defaults: SiteState = {
  theme: {
    bg: "#ffffff",
    text: "#0b0b0f",
    accent: "#5b6cff",
  },
  typography: {
    fontFamily: "Inter",
    scale: 1,
  },
  layout: {
    alignment: "left",
    heroVariant: "split",
  },
  copy: {
    headline: "Make it yours",
    subheadline: "A starter landing page you can redesign by chatting.",
    cta: "Get started",
    body: "Tell the agent what you want — colors, copy, type, layout — and watch the preview update in real time.",
  },
  features: [
    { title: "Tool-driven", body: "Every change is a structured tool call." },
    { title: "Live preview", body: "The right pane re-renders after each turn." },
    { title: "Inworld-routed", body: "LLM calls flow through the Inworld Router." },
  ],
};

const state: SiteState = structuredClone(defaults);

export function getState(): SiteState {
  return state;
}

export function setTheme(patch: Partial<ThemeTokens>): SiteState {
  Object.assign(state.theme, patch);
  return state;
}

export function setTypography(patch: Partial<TypographyTokens>): SiteState {
  Object.assign(state.typography, patch);
  return state;
}

export function setLayout(patch: Partial<LayoutTokens>): SiteState {
  Object.assign(state.layout, patch);
  return state;
}

export function setCopy(slot: CopySlot, text: string): SiteState {
  state.copy[slot] = text;
  return state;
}

export function resetState(): SiteState {
  const fresh = structuredClone(defaults);
  state.theme = fresh.theme;
  state.typography = fresh.typography;
  state.layout = fresh.layout;
  state.copy = fresh.copy;
  state.features = fresh.features;
  return state;
}
