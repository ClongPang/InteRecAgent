import type { IconName } from '../components/ui/Icon'

export function categoryIconFor(title: string): IconName {
  if (/(耳机|降噪|headphone|earbuds)/i.test(title)) return 'headphones'
  if (/(显示器|monitor|4k|屏幕)/i.test(title)) return 'monitor'
  if (/(徒步鞋|运动鞋|跑鞋|登山鞋|鞋)/i.test(title)) return 'shoe'
  return 'search'
}
