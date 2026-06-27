import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // Replace with the production URL once Netlify assigns one (or a custom domain).
  site: 'https://music-cities-concerts.netlify.app',
  output: 'static',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
  },
  vite: {
    build: {
      // Don't fail the build over unused locals during early scaffolding.
      sourcemap: false,
    },
  },
});
