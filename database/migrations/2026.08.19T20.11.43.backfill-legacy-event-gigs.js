'use strict'

// Strapi loads migrations with `require()`, not a TS/ESM loader.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const crypto = require('node:crypto')

// Before the Event->Gig model existed, an `event` row's own dateStart/
// dateEnd/location/title/description/url/image fields described its one
// and only performance. The frontend still reads those flat fields as an
// implicit single gig for any event with no `gigs` (see
// `transformLegacyEvent` in creal's events page), so this migration is
// optional for correctness - it only exists to give old events a real
// `gig` row, e.g. so editors can add a second gig to them later.
//
// Only events with a `dateStart` and no gig already linked are backfilled,
// mirroring the frontend's own legacy/gig-model split exactly.

const EVENT_UID = 'api::event.event'
const GIG_UID = 'api::gig.gig'

module.exports = {
  async up(knex) {
    const legacyEvents = await knex('events')
      .whereNotNull('date_start')
      .whereNotExists(function () {
        this.select('*')
          .from('gigs_event_lnk')
          .whereRaw('gigs_event_lnk.event_id = events.id')
      })

    for (const event of legacyEvents) {
      const [inserted] = await knex('gigs')
        .insert({
          document_id: crypto.randomBytes(12).toString('hex'),
          title: event.title,
          description: event.description,
          date_start: event.date_start,
          date_end: event.date_end,
          url: event.url,
          location: event.location,
          created_at: event.created_at,
          updated_at: event.updated_at,
          published_at: event.published_at,
          created_by_id: event.created_by_id,
          updated_by_id: event.updated_by_id,
          locale: event.locale,
        })
        .returning('id')
      const gigId = inserted.id ?? inserted

      await knex('gigs_event_lnk').insert({
        gig_id: gigId,
        event_id: event.id,
        gig_ord: 1,
      })

      const eventImages = await knex('files_related_mph').where({
        related_id: event.id,
        related_type: EVENT_UID,
        field: 'image',
      })

      for (const image of eventImages) {
        await knex('files_related_mph').insert({
          file_id: image.file_id,
          related_id: gigId,
          related_type: GIG_UID,
          field: 'image',
          order: image.order,
        })
      }
    }
  },

  async down() {
    throw new Error(
      'Reverting would delete backfilled gigs indiscriminately - restore from a backup instead.',
    )
  },
}
