export type Article = {
  id: string
  title: string
  kicker: string
  image: string
  body: string
}

const LOREM = [
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.',
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.',
].join('\n\n')

export const articles: Array<Article> = [
  {
    id: '1',
    title: 'React canary ships shared element transitions',
    kicker: 'Framework',
    image: '/img/1.svg',
    body: LOREM,
  },
  {
    id: '2',
    title: 'The router that forgot to be a transition',
    kicker: 'Routing',
    image: '/img/2.svg',
    body: LOREM,
  },
  {
    id: '3',
    title: 'useSyncExternalStore, explained slowly',
    kicker: 'Deep dive',
    image: '/img/3.svg',
    body: LOREM,
  },
  {
    id: '4',
    title: 'Why your animation snapped instead of morphed',
    kicker: 'Debugging',
    image: '/img/4.svg',
    body: LOREM,
  },
  {
    id: '5',
    title: 'A very short history of the view transition API',
    kicker: 'Platform',
    image: '/img/5.svg',
    body: LOREM,
  },
]

export function getArticle(id: string): Article | undefined {
  return articles.find((a) => a.id === id)
}
