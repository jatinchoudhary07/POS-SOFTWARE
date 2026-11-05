import '@fontsource/montserrat/900.css';
import '@fontsource/pacifico/400.css';
import { useEffect, useState } from 'react';
import './splash.css';

const SEEN_KEY = 'pos.splash.seen';
/** The longest animation ends at about 2.7 s; hold the finished logo briefly, then fade out. */
const HOLD_MS = 3500;
const FADE_MS = 450;

const alreadySeen = () => {
  try {
    return sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * The Praveen Pranks · Two Hearts Cafe logo animation, shown when the website is opened.
 * Black logo on the light theme, white on the dark theme (it follows the device theme).
 * It plays once per browser session, covers the app while it loads, and can be skipped with a tap or key press.
 */
export function SplashScreen() {
  const [phase, setPhase] = useState<'off' | 'show' | 'leaving'>(() => (alreadySeen() ? 'off' : 'show'));
  const [fontsReady, setFontsReady] = useState(false);

  // Start the animation only when the logo fonts are ready (but never wait more than 1.5 s).
  useEffect(() => {
    if (phase !== 'show') return;
    let live = true;
    const loaded = Promise.all([document.fonts.load('900 84px Montserrat'), document.fonts.load('57px Pacifico')]);
    Promise.race([loaded, new Promise((r) => setTimeout(r, 1500))])
      .catch(() => undefined)
      .then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, [phase]);

  // Hold the finished logo, then fade out and remove it.
  useEffect(() => {
    if (phase !== 'show' || !fontsReady) return;
    const t = setTimeout(() => setPhase('leaving'), HOLD_MS);
    return () => clearTimeout(t);
  }, [phase, fontsReady]);

  useEffect(() => {
    if (phase !== 'leaving') return;
    try {
      sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* private mode: it will simply play again next time */
    }
    const t = setTimeout(() => setPhase('off'), FADE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // Any key press skips it.
  useEffect(() => {
    if (phase !== 'show') return;
    const skip = () => setPhase('leaving');
    window.addEventListener('keydown', skip, { once: true });
    return () => window.removeEventListener('keydown', skip);
  }, [phase]);

  if (phase === 'off') return null;

  return (
    <div
      className={`sp-root${fontsReady ? ' sp-go' : ''}${phase === 'leaving' ? ' sp-leaving' : ''}`}
      onClick={() => setPhase('leaving')}
      role="img"
      aria-label="Praveen Pranks, Two Hearts Cafe"
    >
      <div className="sp-wrap">
        <svg viewBox="0 0 1200 330" xmlns="http://www.w3.org/2000/svg" aria-hidden>
          <g className="sp-glow">
            <text className="sp-name sp-left" x="65" y="145">
              PRAVEEN
            </text>

            {/* Two red hearts, matching the signboard mark */}
            <path className="sp-heart" d="M600 91 C578 55 523 62 523 108 C523 145 568 177 600 204 C632 177 677 145 677 108 C677 62 622 55 600 91Z" />
            <path className="sp-heart sp-heart-2" d="M680 100 C662 72 620 78 620 114 C620 143 655 168 680 189 C705 168 740 143 740 114 C740 78 698 72 680 100Z" />

            <text className="sp-name sp-right" x="760" y="145">
              PRANKS
            </text>

            <path className="sp-swash" d="M78 228 C155 192 210 250 288 218" />
            <path className="sp-swash sp-swash-right" d="M915 218 C990 250 1045 192 1122 228" />

            <text className="sp-tagline" x="600" y="250" textAnchor="middle">
              Two Hearts Cafe
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}
