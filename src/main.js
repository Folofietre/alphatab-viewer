import { createApp } from 'vue'
import './styles/main.scss'
import App from './App.vue'
import { help } from './directives/help'

createApp(App).directive('help', help).mount('#app')
