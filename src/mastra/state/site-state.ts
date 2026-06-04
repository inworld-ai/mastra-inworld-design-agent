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

/** Baked-in styling treatment, independent of the color/font theme.
 *  "garish" = borders + hard drop-shadows + WordArt headline (the 90s default);
 *  "tasteful" = thin subtle borders, rounded corners, no hard shadows. */
export type DecorMode = "garish" | "tasteful";

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
  marquee: string;
  decor: DecorMode;
};

export const defaults: SiteState = {
  theme: {
    bg: "#ffffff",
    text: "#000000",
    accent: "#0000ee",
  },
  typography: {
    fontFamily: "Times New Roman",
    scale: 1,
  },
  layout: {
    alignment: "left",
    heroVariant: "stacked",
  },
  copy: {
    headline: "My design is lacking. Can you help me?",
    subheadline:
      "This is my landing page. It is stuck in 1996 — Times New Roman, hard drop shadows, double-ruled dividers, and a scrolling marquee. It is honest, but my goodness it is loud.",
    cta: "CLICK HERE!\n(to start the redesign)",
    body: "Press the button below and start talking. Tell me what to change — colors, fonts, the headline you're reading right now, the layout, anything. I will redesign myself live.",
  },
  features: [
    {
      title: "Tell me a vibe",
      body: 'Say things like "make it feel like a Swiss design poster" or "I want it to look like a startup from 2014".',
    },
    {
      title: "Or be specific",
      body: 'Say "background cream, headline serif, accent red" and watch each change land.',
    },
    {
      title: "Or pick a preset",
      body: 'Say "apply the sunset preset". Presets: default, dark, cream, ocean, sunset, mono, forest, neon.',
    },
    {
      title: "Edit anything you see",
      body: 'Even this card. Say "change the third feature" or "add a card about pricing".',
    },
  ],
  marquee: "Powered by Inworld AI (#1 Ranked TTS) and Mastra (Best Typescript Agent Framework)",
  decor: "garish",
};

export type PresetName =
  | "default"
  | "dark"
  | "cream"
  | "ocean"
  | "sunset"
  | "mono"
  | "forest"
  | "neon";

export const presets: Record<
  PresetName,
  { theme: ThemeTokens; typography?: Partial<TypographyTokens> }
> = {
  default: { theme: { bg: "#ffffff", text: "#0b0b0f", accent: "#5b6cff" } },
  dark: { theme: { bg: "#0b0b0f", text: "#f5f5f8", accent: "#7c8bff" } },
  cream: {
    theme: { bg: "#f6efe2", text: "#2a1d10", accent: "#c9572b" },
    typography: { fontFamily: "IBM Plex Serif" },
  },
  ocean: { theme: { bg: "#0a1f3d", text: "#e8f1ff", accent: "#33d4ff" } },
  sunset: {
    theme: { bg: "#ffd8c2", text: "#3a1212", accent: "#e8451a" },
    typography: { fontFamily: "Fraunces" },
  },
  mono: { theme: { bg: "#ffffff", text: "#0b0b0f", accent: "#0b0b0f" } },
  forest: { theme: { bg: "#0f2a1d", text: "#eef7ee", accent: "#d4af37" } },
  neon: {
    theme: { bg: "#0a0014", text: "#f0e8ff", accent: "#ff2bd6" },
    typography: { fontFamily: "Space Grotesk" },
  },
};

/**
 * One isolated copy of the site state, with setters bound to it. Each
 * WebSocket session creates its own instance — no cross-talk between users.
 */
export type SiteStateStore = ReturnType<typeof createSiteState>;

export function createSiteState() {
  const state: SiteState = structuredClone(defaults);

  return {
    get(): SiteState {
      return state;
    },

    setTheme(patch: Partial<ThemeTokens>): SiteState {
      Object.assign(state.theme, patch);
      return state;
    },

    setTypography(patch: Partial<TypographyTokens>): SiteState {
      Object.assign(state.typography, patch);
      return state;
    },

    setLayout(patch: Partial<LayoutTokens>): SiteState {
      Object.assign(state.layout, patch);
      return state;
    },

    setCopy(slot: CopySlot, text: string): SiteState {
      state.copy[slot] = text;
      return state;
    },

    setMarquee(text: string): SiteState {
      state.marquee = text;
      return state;
    },

    setDecor(mode: DecorMode): SiteState {
      state.decor = mode;
      return state;
    },

    addFeature(card: FeatureCard, index?: number): SiteState {
      if (typeof index === "number" && index >= 0 && index <= state.features.length) {
        state.features.splice(index, 0, card);
      } else {
        state.features.push(card);
      }
      return state;
    },

    removeFeature(index: number): SiteState {
      if (index >= 0 && index < state.features.length) {
        state.features.splice(index, 1);
      }
      return state;
    },

    updateFeature(index: number, patch: Partial<FeatureCard>): SiteState {
      if (index >= 0 && index < state.features.length) {
        Object.assign(state.features[index], patch);
      }
      return state;
    },

    applyPreset(name: PresetName): SiteState {
      const preset = presets[name];
      if (!preset) return state;
      state.theme = { ...preset.theme };
      if (preset.typography) Object.assign(state.typography, preset.typography);
      return state;
    },

    reset(): SiteState {
      const fresh = structuredClone(defaults);
      state.theme = fresh.theme;
      state.typography = fresh.typography;
      state.layout = fresh.layout;
      state.copy = fresh.copy;
      state.features = fresh.features;
      state.marquee = fresh.marquee;
      state.decor = fresh.decor;
      return state;
    },
  };
}
