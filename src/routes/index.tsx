import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { startTransition, useState } from 'react'
import { ViewTransition } from '../ViewTransition'
import { articles } from '../data/articles'
import { validateRows } from '../rows'

export const Route = createFileRoute('/')({
  validateSearch: validateRows,
  component: NewsList,
})

function NewsList() {
  const navigate = useNavigate()
  const search = Route.useSearch()

  // Control group: a plain React state update, explicitly marked as a
  // transition. The same <ViewTransition> elements animate here.
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="page">
      <header className="masthead">
        <h1>The Daily Transition</h1>
      </header>

      <p className="note">
        <strong>Patched:</strong> every cover image below is wrapped in React's{' '}
        <code>&lt;ViewTransition&gt;</code> with a shared <code>name</code>, and
        so is the hero image on the article page. All three now animate &mdash;
        including navigation. The router is running with{' '}
        <code>experimental_concurrentRenderFrames</code>, which publishes router
        state to React as one immutable frame per navigation instead of through{' '}
        <code>useSyncExternalStore</code>, so the update keeps its transition
        lane and <code>&lt;ViewTransition&gt;</code> fires.
      </p>

      <div className="controls">
        <button onClick={() => startTransition(() => setExpanded((e) => !e))}>
          React state + startTransition
        </button>
        <button
          onClick={() =>
            startTransition(() => {
              navigate({
                to: '/article/$id',
                params: { id: '1' },
                search,
              })
            })
          }
        >
          Router navigate + startTransition
        </button>
      </div>

      <div className={expanded ? 'list expanded' : 'list'}>
        {articles.map((article) => (
          <Link
            key={article.id}
            to="/article/$id"
            params={{ id: article.id }}
            search={search}
            className="card"
          >
            <ViewTransition name={`article-image-${article.id}`}>
              <img src={article.image} alt="" />
            </ViewTransition>
            <div className="card-body">
              <p className="kicker">{article.kicker}</p>
              <h2>{article.title}</h2>
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
