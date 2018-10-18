const EventEmitter = require('events')
const mp4box = require('mp4box')
const stream = require('stream')

class MP4Remuxer extends EventEmitter {
    constructor (file) {
        super()

        this._file = file
        this._ready = false
        this.mp4box = new mp4box.MP4Box()

        this.mp4box.onReady = (info)=>{
            this._ready = true
            let datas = []
            for (let i = 0, t = info.tracks.length; i < t; ++i) {
                let track = info.tracks[i]
                let codec = track.codec
                let track_id = track.id
                this.mp4box.setSegmentOptions(track_id, track, { nbSamples: 1000 } )

            }

            let initSegs = this.mp4box.initializeSegmentation();
            for (let i = 0; i < initSegs.length; i++) {
                let track = initSegs[i].user
                datas.push({
                    mime: 'video/mp4; codecs=\"'+codec+'\"',
                    init: initSegs[i].buffer
                })
            }

            this.emit('ready', datas)
        }

        this._loadMeta(0)
    }

    _loadMeta (from) {
        if (this._ready) return;
        let size = 16384;
        let stream = this._file.createReadStream({
            start: from,
            end: from + size - 1
        })
        let chunks = []
        stream.on('data',  (chunk)=>{
            chunks.push(chunk)
        })
        stream.on('end', ()=>{
            let buf = Buffer.concat(chunks)
            let readOffset = this.mp4box.appendBuffer(buf)
            this._loadMeta(readOffset)
        })
    }

}

module.exports = MP4Remuxer
