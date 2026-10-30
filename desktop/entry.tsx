import { createRoot } from 'react-dom/client';
import Home from '../app/page';
import '../app/globals.css';

/** 桌面窗口中用于渲染控制台的页面节点 */
const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('控制台页面节点不存在');
createRoot(rootElement).render(<Home />);
