import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import * as directives from 'vuetify/directives';
import { aliases, mdi } from 'vuetify/iconsets/mdi';

export const vuetify = createVuetify({
  components,
  directives,
  icons: {
    defaultSet: 'mdi',
    aliases,
    sets: { mdi },
  },
  theme: {
    defaultTheme: 'localInfraDark',
    themes: {
      localInfraDark: {
        dark: true,
        colors: {
          background: '#07101d',
          surface: '#101b2b',
          'surface-bright': '#17263b',
          'surface-light': '#1c2d45',
          primary: '#6ea8fe',
          secondary: '#9a8cff',
          success: '#4ade80',
          warning: '#fbbf24',
          error: '#fb7185',
          info: '#38bdf8',
        },
      },
    },
  },
  defaults: {
    VBtn: {
      rounded: 'lg',
      elevation: 0,
      variant: 'tonal',
    },
    VTextField: {
      density: 'compact',
      variant: 'outlined',
      hideDetails: 'auto',
    },
    VSelect: {
      density: 'compact',
      variant: 'outlined',
      hideDetails: 'auto',
    },
  },
});
