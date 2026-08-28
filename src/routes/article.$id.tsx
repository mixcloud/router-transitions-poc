import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { ViewTransition } from '../ViewTransition'
import { getArticle } from '../data/articles'

export const Route = createFileRoute('/article/$id')({
  loader: ({ params }) => {
    const article = getArticle(params.id)
    if (!article) throw notFound()
    return article
  },
  component: ArticleDetail,
})

function ArticleDetail() {
  const article = Route.useLoaderData()

  return (
    <div className="page article">
      <header className="masthead">
        <Link to="/" className="back">
          &larr; Back to the news
        </Link>
      </header>

      <ViewTransition name={`article-image-${article.id}`}>
        <img className="hero" src={article.image} alt="" />
      </ViewTransition>

      <p className="kicker">{article.kicker}</p>
      <h1>{article.title}</h1>
      {article.body.split('\n\n').map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
    </div>
  )
}
