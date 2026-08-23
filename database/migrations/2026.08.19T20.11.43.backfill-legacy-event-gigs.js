'use strict'

// Strapi loads migrations with `require()`, not a TS/ESM loader.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('node:crypto')

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
// This migration finds those same-titled, closely-dated legacy rows,
// keeps the richest one as the surviving Event, and turns the rest into
// that Event's Gigs. Legacy events with no such duplicate are left alone -
// the frontend already displays a gig-less event correctly from its own
// fields, so there's nothing to backfill for them.
//
// Only events with a `dateStart` and no gig already linked are considered,
// so events already curated under the new model (or previously processed
// by this migration) are never touched twice.

const EVENT_UID = 'api::event.event'
const GIG_UID = 'api::gig.gig'
const CLUSTER_GAP_MILLISECONDS = 7 * 24 * 60 * 60 * 1000 // 7 days

const clusterByProximity = (events) => {
  const sorted = [...events].sort(
    (a, b) => new Date(a.date_start) - new Date(b.date_start),
  )

  const clusters = []
  let current = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const gap =
      new Date(sorted[i].date_start) - new Date(sorted[i - 1].date_start)

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

module.exports = {
  async up(knex) {
    // Custom migrations run before Strapi's content-type schema sync, so on
    // a genuinely fresh install `events`/`gigs` don't exist yet - and there's
    // nothing to backfill anyway.
    if (!(await knex.schema.hasTable('events'))) {
      return
    }

    const legacyEvents = await knex('events')
      .whereNotNull('date_start')
      .whereNotExists(function () {
        this.select('*')
          .from('gigs_event_lnk')
          .whereRaw('gigs_event_lnk.event_id = events.id')
      })

    const groups = new Map()
    for (const event of legacyEvents) {
      const key = `${event.locale} ${event.title}`
      if (!groups.has(key)) {
        groups.set(key, [])
      }
      groups.get(key).push(event)
    }

    for (const group of groups.values()) {
      for (const cluster of clusterByProximity(group)) {
        if (cluster.length === 1) {
          continue
        }

        const imageCounts = new Map()
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

        const richness = (event) =>
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
              created_at: event.created_at,
              created_by_id: event.created_by_id,
              date_end: event.date_end,
              date_start: event.date_start,
              description: event.description,
              document_id: crypto.randomBytes(12).toString('hex'),
              location: event.location,
              locale: event.locale,
              published_at: event.published_at,
              title: event.title,
              updated_at: event.updated_at,
              updated_by_id: event.updated_by_id,
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
  },

  async down() {
    throw new Error(
      'Reverting would delete backfilled gigs and merged event rows indiscriminately - restore from a backup instead.',
    )
  },
}
