import { createApp } from 'vue';
import './style.css';

createApp({
  data: () => ({ count: 0 }),
  template: `
    <main>
      <p class="eyebrow">Managed Vue service</p>
      <h1>Vue Hello is running</h1>
      <p>This page is served by the Application Services manager.</p>
      <button @click="count += 1">Clicked {{ count }} times</button>
    </main>
  `,
}).mount('#app');
