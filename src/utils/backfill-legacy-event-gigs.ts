import type { Core } from '@strapi/strapi'
import crypto from 'node:crypto'

// Before the Event->Gig model existed, one performance was one `event` row:
// its own dateStart/dateEnd/location/title/description/url/image fields
// described it directly, and the frontend rendered them as-is (see
// `CrEvent.vue` in creal, which still displays an event's own fields
// whether or not it has gigs). Recurring performances - a festival with
// several days, a conference happening again next year - were entered as
// several `event` rows sharing the same title, one carrying the rich
// details (description/image/url) and the rest bare placeholders for the
// other times. That's the exact shape the new Gig model was built for:
// one Event with several Gigs.
//
// This runs in `bootstrap()` rather than as a `database/migrations/*.js`
// migration because custom migrations execute before Strapi syncs new
// content-type tables into the schema (see `db.schema.sync()` in
// `@strapi/core`), so a migration shipped in the same release as the Gig
// content type can never see `gigs`/`gigs_event_lnk` yet. `bootstrap()`
// runs after schema sync, so those tables always exist by the time this
// runs. The `WHERE NOT EXISTS` guard below makes it safe (and cheap) to
// run on every boot.

type Knex = Core.Strapi['db']['connection']

const EVENT_UID = 'api::event.event'
const GIG_UID = 'api::gig.gig'
const CLUSTER_GAP_MILLISECONDS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface LegacyEvent {
  createdAt: string
  createdById: number | null
  dateEnd: string | null
  dateStart: string
  description: string | null
  id: number
  locale: string
  location: string | null
  publishedAt: string | null
  title: string
  updatedAt: string
  updatedById: number | null
  url: string | null
}

const clusterByProximity = (events: LegacyEvent[]) => {
  const sorted = [...events].sort(
    (a, b) => new Date(a.dateStart).getTime() - new Date(b.dateStart).getTime(),
  )

  const clusters: LegacyEvent[][] = []
  let current = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const gap =
      new Date(sorted[i].dateStart).getTime() -
      new Date(sorted[i - 1].dateStart).getTime()

    if (gap <= CLUSTER_GAP_MILLISECONDS) {
      current.push(sorted[i])
    } else {
      clusters.push(current)
      current = [sorted[i]]
    }
  }
  clusters.push(current)

  return clusters
}

export const backfillLegacyEventGigs = async (strapi: Core.Strapi) => {
  const knex: Knex = strapi.db.connection

  const legacyEvents: LegacyEvent[] = await knex('events')
    .whereNotNull('date_start')
    .whereNotExists(function () {
      this.select('*')
        .from('gigs_event_lnk')
        .whereRaw('gigs_event_lnk.event_id = events.id')
    })
    .select({
      createdAt: 'created_at',
      createdById: 'created_by_id',
      dateEnd: 'date_end',
      dateStart: 'date_start',
      description: 'description',
      id: 'id',
      locale: 'locale',
      location: 'location',
      publishedAt: 'published_at',
      title: 'title',
      updatedAt: 'updated_at',
      updatedById: 'updated_by_id',
      url: 'url',
    })

  const groups = new Map<string, LegacyEvent[]>()
  for (const event of legacyEvents) {
    const key = `${event.locale} ${event.title}`
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key)!.push(event)
  }

  for (const group of groups.values()) {
    for (const cluster of clusterByProximity(group)) {
      if (cluster.length === 1) {
        continue
      }

      const imageCounts = new Map<number, number>()
      for (const event of cluster) {
        const { count } = await knex('files_related_mph')
          .where({
            field: 'image',
            related_id: event.id,
            related_type: EVENT_UID,
          })
          .count({ count: '*' })
          .first()
        imageCounts.set(event.id, Number(count))
      }

      const richness = (event: LegacyEvent) =>
        (event.description ? 2 : 0) +
        (imageCounts.get(event.id) ? 2 : 0) +
        (event.url ? 1 : 0)

      const survivor = cluster.reduce((best, event) =>
        richness(event) > richness(best) ? event : best,
      )

      let gigOrd = 1
      for (const event of cluster) {
        if (event === survivor) {
          continue
        }

        const [inserted] = await knex('gigs')
          .insert({
            created_at: event.createdAt,
            created_by_id: event.createdById,
            date_end: event.dateEnd,
            date_start: event.dateStart,
            description: event.description,
            document_id: crypto.randomBytes(12).toString('hex'),
            location: event.location,
            locale: event.locale,
            published_at: event.publishedAt,
            title: event.title,
            updated_at: event.updatedAt,
            updated_by_id: event.updatedById,
            url: event.url,
          })
          .returning('id')
        const gigId = inserted.id ?? inserted

        await knex('gigs_event_lnk').insert({
          event_id: survivor.id,
          gig_id: gigId,
          gig_ord: gigOrd++,
        })

        await knex('files_related_mph')
          .where({
            field: 'image',
            related_id: event.id,
            related_type: EVENT_UID,
          })
          .update({ related_id: gigId, related_type: GIG_UID })

        await knex('events').where({ id: event.id }).delete()
      }
    }
  }
}
