import { NeuralGlow } from './NeuralGlow.js';

export function Background() {
  return (
    <div className="als-scene" aria-hidden="true">
      <picture>
        <source media="(prefers-reduced-motion: reduce)" srcSet="/als/background.webp" />
        <img
          className="page-background"
          src="/als/background.gif"
          alt=""
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      </picture>
      <div className="background-overlay" />
      <NeuralGlow />
    </div>
  );
}
