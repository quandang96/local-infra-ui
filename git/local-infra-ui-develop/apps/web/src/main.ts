import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { router } from './router';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import { vuetify } from './plugins/vuetify';
import './styles.css';

createApp(App).use(createPinia()).use(router).use(vuetify).use(ElementPlus).mount('#app');
