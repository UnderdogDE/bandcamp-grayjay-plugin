/**
 * TODO: Somehow support or avoid custom band domains
 * TODO: Raise to support subdomains in allowUrls
 */
const PLATFORM_CLAIMTYPE = 16
const BASE_URL = "https://bandcamp.com"
const API_URL = `${BASE_URL}/api`
const NOTABLE_URL = `${API_URL}/notabletralbum/2/get`
const BAND_QUERY_URL = `${API_URL}/mobile/22/band_details`
const ALBUM_QUERY_URL = `${API_URL}/mobile/22/tralbum_details`
const SEARCH_URL = `${API_URL}/bcsearch_public_api/1/autocomplete_elastic`

// The value used by the homepage as of writing (2024-05-08)
const NOTABLE_PER_PAGE = 15

var config = {}

source.enable = function (conf) {
  config = conf ?? {}
  return true
}

source.getHome = function (offset) {
  if (!offset) {
    const home_page = http.GET(
      BASE_URL,
      {
        Connection: "keep-alive",
      },
      false,
    ).body

    const newest_notable_id = home_page.match(/bcnt_seq&quot;:\[(\d+),/)
    if (!newest_notable_id) {
      return new ContentPager([], false, {})
    }

    offset = Number(newest_notable_id[1])
  }

  // The most recent ID is the greatest one, so decrement to get the next batch
  const results = JSON.parse(
    http.GET(
      `${NOTABLE_URL}?id=${decreasing_range(offset, NOTABLE_PER_PAGE).join(",")}`,
      {
        Connection: "keep-alive",
      },
      false,
    ).body,
  )

  const playlists = Object.values(results)
    .reverse()
    .map(notableToPlatformPlaylist)

  const next_offset = offset - NOTABLE_PER_PAGE - 1
  return new HomePager(playlists, next_offset > 0, {
    offset: offset - NOTABLE_PER_PAGE - 1,
  })
}

source.isChannelUrl = function (url) {
  return /.*\.bandcamp.com(\/music)?(?!\/(track|album))/.test(url)
}

source.getChannel = function (url) {
  const channel_page = http.GET(
    url,
    {
      Connection: "keep-alive",
    },
    false,
  ).body

  const band_id = channel_page.match(/\/contact\?b=(\d+)/)
  if (!band_id) {
    throw new ScriptException("Failed to find Band ID")
  }

  return toPlatformChannel(queryBand(band_id[1]))
}

source.getChannelContents = function (url) {
  const band_url = url.match(/https:\/\/([^\.]+).bandcamp.com/)[0]

  const music_page = http.GET(
    // Specifically request the page with albums. Some bands set a different
    // page as the default.
    `${band_url}/music`,
    {
      Connection: "keep-alive",
    },
    false,
  ).body

  const band_id = music_page.match(/\/contact\?b=(\d+)/)
  if (!band_id) {
    throw new ScriptException("Failed to find Band ID")
  }

  // Sometimes track/album URLs are absolute, sometimes they're relative to the subdomain
  const albums = Array.from(
    music_page.matchAll(
      /"(?:https:\/\/.*\.bandcamp.com)?(\/(track|album)\/.*)"/g,
    ),
  ).map((v) => v[1])
  if (!albums) {
    throw new ScriptException("Failed to find album items")
  }

  const band = queryBand(band_id[1])

  const convertToPlatform = function (item, i) {
    const author = new PlatformAuthorLink(
      new PlatformID(
        config.name,
        item.band_id.toString(),
        config.id,
        PLATFORM_CLAIMTYPE,
      ),
      item.band_name,
      url,
      getBandImage(band.bio_image_id ?? band.img_id, 5),
    )

    const item_url = `${band.bandcamp_url}${albums[i]}`

    switch (item.item_type) {
      case "album": {
        return new PlatformPlaylist({
          id: new PlatformID(
            config.name,
            item.item_id.toString(),
            config.id,
            PLATFORM_CLAIMTYPE,
          ),
          author: author,
          url: item_url,
          name: item.title,
          thumbnail: getAlbumImage(item.art_id, 5),
        })
      }
      case "track": {
        return new PlatformVideo({
          id: new PlatformID(
            config.name,
            item.item_id.toString(),
            config.id,
            PLATFORM_CLAIMTYPE,
          ),
          name: item.title,
          thumbnails: new Thumbnails([
            new Thumbnail(getAlbumImage(item.art_id, 5)),
          ]),
          author: author,
          url: item_url,
          duration: 0,
        })
      }
    }
  }

  return new VideoPager(band.discography.map(convertToPlatform), false, {})
}

source.isPlaylistUrl = function (url) {
  return /.*\.bandcamp.com\/album\//.test(url)
}

source.getPlaylist = function (url) {
  const album_page = http.GET(
    url,
    {
      Connection: "keep-alive",
    },
    false,
  ).body

  const band_id = album_page.match(/band_id&quot;:(\d+),/)
  const album_id = album_page.match(/tralbum_id&quot;:(\d+),/)

  if (!band_id || !album_id) {
    throw new ScriptException("Failed to find Band ID and Album ID")
  }

  const track_slugs = Array.from(
    album_page.matchAll(/info_link.*"(\/track\/.*)"/g),
  ).map((v) => v[1])

  return toPlatformPlaylistContents(
    queryAlbum(band_id[1], album_id[1]),
    track_slugs,
  )
}

source.isContentDetailsUrl = function (url) {
  return /.*\.bandcamp.com\/track\//.test(url)
}

source.getContentDetails = function (url) {
  const album_page = http.GET(
    url,
    {
      Connection: "keep-alive",
    },
    false,
  ).body

  const band_id = album_page.match(/band_id&quot;:(\d+),/)
  const album_id = album_page.match(/tralbum_id&quot;:(\d+),/)

  if (!band_id || !album_id) {
    throw new ScriptException("Failed to find Band ID and Album ID")
  }

  return toPlatformVideoDetails(queryTrack(band_id[1], album_id[1]))
}

source.search = function (query, type, order, filters, search_filter) {
  const response = http.POST(
    SEARCH_URL,
    JSON.stringify({
      search_text: query,
      search_filter: search_filter ?? "t",
      full_page: true,
      fan_id: null,
    }),
    {
      Connection: "keep-alive",
    },
    false,
  ).body

  const convertToPlatform = function (result) {
    switch (result.type) {
      case "a": {
        return toPlatformPlaylist(result)
      }
      case "b": {
        return toPlatformChannel(result)
      }
      case "t": {
        return toPlatformVideo(result)
      }
    }
  }

  const videos = JSON.parse(response)
    .auto.results.filter((v) => ["a", "b", "t"].includes(v.type))
    .map(convertToPlatform)

  return new VideoPager(videos, false, {})
}

source.searchPlaylists = function (query, type, order, filters) {
  return source.search(query, type, order, filters, "a")
}

source.searchChannels = function (query) {
  return source.search(query, undefined, undefined, undefined, "b")
}

class HomePager extends ContentPager {
  constructor(results, hasMore, context) {
    super(results, hasMore, context)
  }

  nextPage() {
    return source.getHome(this.context.offset)
  }
}

function getBandImage(id, quality) {
  return `https://f4.bcbits.com/img/00${id}_${quality}.jpg`
}

function getAlbumImage(id, quality) {
  return `https://f4.bcbits.com/img/a${id}_${quality}.jpg`
}

function queryBand(band_id) {
  let response = http.POST(
    BAND_QUERY_URL,
    JSON.stringify({
      band_id: band_id,
    }),
    {
      Connection: "keep-alive",
    },
    false,
  )

  return JSON.parse(response.body)
}

function queryAlbum(band_id, album_id) {
  let response = http.POST(
    ALBUM_QUERY_URL,
    JSON.stringify({
      band_id: band_id,
      tralbum_id: album_id,
      tralbum_type: "a",
    }),
    {
      Connection: "keep-alive",
    },
    false,
  )

  return JSON.parse(response.body)
}

function queryTrack(band_id, track_id) {
  let response = http.POST(
    ALBUM_QUERY_URL,
    JSON.stringify({
      band_id: band_id,
      tralbum_id: track_id,
      tralbum_type: "t",
    }),
    {
      Connection: "keep-alive",
    },
    false,
  )

  return JSON.parse(response.body)
}

function toPlatformChannel(band) {
  return new PlatformChannel({
    id: new PlatformID(
      config.name,
      band.id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    name: band.name,
    thumbnail: getBandImage(band.bio_image_id ?? band.img_id, 5),
    description: band.bio ?? "",
    url: band.bandcamp_url ?? band.item_url_root,
    links: Object.fromEntries((band.sites ?? []).map((v) => [
      v.url.match(/(?:https?:\/\/)?(?:www.)?((([^\.\/]*)\.)+([^\/]+))/)[1],
      v.url,
    ])),
  })
}

function toPlatformPlaylist(album) {
  return new PlatformPlaylist({
    id: new PlatformID(
      config.name,
      album.id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    author: new PlatformAuthorLink(
      new PlatformID(
        config.name,
        album.band_id.toString(),
        config.id,
        PLATFORM_CLAIMTYPE,
      ),
      album.band_name,
      album.item_url_root,
      "",
    ),
    url: album.item_url_path,
    name: album.name,
    thumbnail: getAlbumImage(album.art_id, 5),
  })
}

function toPlatformPlaylistContents(album, track_slugs) {
  const band_url = album.bandcamp_url.match(
    /https:\/\/([^\.]+).bandcamp.com/,
  )[0]

  const author = new PlatformAuthorLink(
    new PlatformID(
      config.name,
      album.band.band_id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    album.band.name,
    band_url,
    "", // thumbnail?
  )

  return new PlatformPlaylistDetails({
    id: new PlatformID(
      config.name,
      album.id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    author: author,
    url: album.bandcamp_url,
    name: album.title,
    videoCount: album.tracks.length,
    thumbnail: getAlbumImage(album.art_id, 5),
    contents: new ContentPager(
      album.tracks
        .filter((t) => t.is_streamable)
        .map((track, i) => [author, album, track, track_slugs[i]])
        .map((args) => trackToPlatformVideoDetails(...args)),
      false,
    ),
  })
}

function toPlatformVideoDetails(track) {
  const track_details = track.tracks[0]

  const author = new PlatformAuthorLink(
    new PlatformID(
      config.name,
      track.band.band_id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    track.band.name,
    track.bandcamp_url.match(/https:\/\/([^\.]+).bandcamp.com/)[0],
    getBandImage(track.band.image_id, 3),
  )

  return new PlatformVideoDetails({
    id: new PlatformID(
      config.name,
      track.id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    name: track_details.title,
    thumbnails: new Thumbnails([
      new Thumbnail(getAlbumImage(track_details.art_id ?? track.art_id, 10)),
    ]),
    author: author,
    datetime: track.release_date,
    url: track.bandcamp_url,
    duration: track_details.duration,
    video: new UnMuxVideoSourceDescriptor(
      [],
      Object.entries(track_details.streaming_url).map(
        ([codec, url]) =>
          new AudioUrlSource({
            name: codec,
            duration: track_details.duration,
            url: url,
          }),
      ),
    ),
  })
}

function toPlatformVideo(track) {
  return new PlatformVideo({
    id: new PlatformID(
      config.name,
      track.id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    name: track.name,
    thumbnails: new Thumbnails([new Thumbnail(getAlbumImage(track.art_id, 5))]),
    author: new PlatformAuthorLink(
      new PlatformID(
        config.name,
        track.band_id.toString(),
        config.id,
        PLATFORM_CLAIMTYPE,
      ),
      track.band_name,
      track.item_url_root,
      "",
    ),
    url: track.item_url_path,
    duration: 0,
  })
}

function notableToPlatformPlaylist(album) {
  const domain = album.tralbum_url_hash
  return new PlatformPlaylist({
    id: new PlatformID(
      config.name,
      album.tralbum_id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    author: new PlatformAuthorLink(
      new PlatformID(
        config.name,
        album.band_id.toString(),
        config.id,
        PLATFORM_CLAIMTYPE,
      ),
      album.artist,
      `https://${domain.subdomain}.bandcamp.com`,
      "",
    ),
    url: album.tralbum_url,
    name: album.title,
    thumbnail: getAlbumImage(album.art_id, 5),
    // TODO: Playlists don't support dates yet. Raise upstream?
    // datetime: Date.parse(album.mod_date),
  })
}

function trackToPlatformVideoDetails(author, album, track, track_slug) {
  return new PlatformVideoDetails({
    id: new PlatformID(
      config.name,
      track.track_id.toString(),
      config.id,
      PLATFORM_CLAIMTYPE,
    ),
    name: track.title,
    thumbnails: new Thumbnails([
      new Thumbnail(getAlbumImage(track.art_id ?? album.art_id, 5)),
    ]),
    author: author,
    datetime: album.release_date,
    url: `${author.url}${track_slug}`,
    duration: track.duration,
    video: new UnMuxVideoSourceDescriptor(
      [],
      Object.entries(track.streaming_url).map(
        ([codec, url]) =>
          new AudioUrlSource({
            duration: track.duration,
            url: url,
          }),
      ),
    ),
  })
}

// https://stackoverflow.com/a/29559488
function decreasing_range(start, count) {
  return Array(count)
    .fill()
    .map((_, i) => start - i)
}
