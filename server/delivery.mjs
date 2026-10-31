import { mutateRegistry, withoutWrite } from './store.mjs';

/** 跟踪服务端发送结果；不回滚已匹配的共享步骤，也不宣称浏览器已读到响应 */
export const trackDelivery = (response, hitId) => {
  let terminal = false;
  const complete = (delivery) => {
    if (terminal) return;
    terminal = true;
    response.off('finish', finished);
    response.off('close', closed);
    response.off('error', failed);
    void mutateRegistry((registry) => {
      const hit = registry.hits?.find((item) => item.id === hitId);
      if (!hit) return withoutWrite();
      Object.assign(hit, { delivery, deliveryAt: new Date().toISOString() });
    }).catch((error) => console.error('[Mock Studio] 发送结果保存失败', error));
  };
  const finished = () => complete('finished');
  const closed = () => complete(response.writableFinished ? 'finished' : 'aborted');
  const failed = () => complete('failed');
  response.once('finish', finished);
  response.once('close', closed);
  response.once('error', failed);
  if (response.destroyed) closed();
  return failed;
};
