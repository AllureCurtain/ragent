/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: "hsl(var(--card))",
        "card-foreground": "hsl(var(--card-foreground))",
        popover: "hsl(var(--popover))",
        "popover-foreground": "hsl(var(--popover-foreground))",
        primary: "hsl(var(--primary))",
        "primary-foreground": "hsl(var(--primary-foreground))",
        secondary: "hsl(var(--secondary))",
        "secondary-foreground": "hsl(var(--secondary-foreground))",
        muted: "hsl(var(--muted))",
        "muted-foreground": "hsl(var(--muted-foreground))",
        accent: "hsl(var(--accent))",
        "accent-foreground": "hsl(var(--accent-foreground))",
        destructive: "hsl(var(--destructive))",
        "destructive-foreground": "hsl(var(--destructive-foreground))",
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        "chat-user": "hsl(var(--chat-user))",
        "chat-assistant": "hsl(var(--chat-assistant))"
      },
      fontFamily: {
        display: ["'Manrope'", "'PingFang SC'", "'Microsoft YaHei'", "ui-sans-serif", "system-ui"],
        body: ["'Manrope'", "'PingFang SC'", "'Microsoft YaHei'", "ui-sans-serif", "system-ui"],
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular"]
      },
      boxShadow: {
        soft: "0 18px 44px -28px rgba(15, 48, 45, 0.36)",
        glow: "0 0 0 3px rgba(23, 108, 107, 0.12), 0 14px 32px -24px rgba(15, 48, 45, 0.42)",
        neon: "0 0 0 3px rgba(23, 108, 107, 0.12)"
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: 0, transform: "translateY(10px)" },
          "100%": { opacity: 1, transform: "translateY(0)" }
        },
        "pulse-soft": {
          "0%, 100%": { opacity: 1 },
          "50%": { opacity: 0.5 }
        },
        blink: {
          "0%, 100%": { opacity: 1 },
          "50%": { opacity: 0 }
        },
        "spin-slow": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" }
        },
        glow: {
          "0%, 100%": { opacity: 0.5 },
          "50%": { opacity: 1 }
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" }
        }
      },
      animation: {
        "fade-up": "fade-up 0.42s cubic-bezier(0.16, 1, 0.3, 1)",
        "pulse-soft": "pulse-soft 1.4s ease-in-out infinite",
        blink: "blink 1s step-end infinite",
        "spin-slow": "spin-slow 4s linear infinite",
        glow: "glow 2.6s cubic-bezier(0.16, 1, 0.3, 1) infinite",
        float: "float 6s ease-in-out infinite"
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "grid-pattern":
          "linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)"
      }
    }
  },
  plugins: [require("@tailwindcss/typography")]
};
