const EventEmitter = require('events')
const bs = require('binary-search')
const mp4box = require('./mp4box.all')
const mp4 = require('mp4-stream')
const stream = require('stream')
const RangeSliceStream = require('range-slice-stream')

class MP4Remuxer extends EventEmitter {
    constructor (file) {
        super()

        this._tracks = []
        this._file = file
        this._ready = false
        this.mp4box = new mp4box.MP4Box()

        const self = this
        this.mp4box.onReady = (info)=>{
            self._ready = true
            let datas = []
            for (let i = 0, t = info.tracks.length; i < t; ++i) {
                let track = info.tracks[i]
                let track_id = track.id
                self.mp4box.setSegmentOptions(track_id, track, { nbSamples: 1000 } )
                self._tracks.push(track)
            }

            let initSegs = self.mp4box.initializeSegmentation();
            for (let i = 0; i < initSegs.length; i++) {
                let track = initSegs[i].user
                datas.push({
                    mime: 'video/mp4; codecs=\"'+track.codec+'\"',
                    init: initSegs[i].buffer
                })
            }

            self.emit('ready', datas)
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
            let buf = Buffer.concat(chunks).buffer
            buf.fileStart = from
            let readOffset = this.mp4box.appendBuffer(buf)
            this._loadMeta(readOffset)
        })
    }

    seek (time) {
        if (!this._tracks) {
            throw new Error('Not ready yet; wait for \'ready\' event')
        }

        if (this._fileStream) {
            this._fileStream.destroy()
            this._fileStream = null
        }

        let startOffset = -1
        this._tracks.map((track, i) => {
            // find the keyframe before the time
            // stream from there
            if (track.outStream) {
                track.outStream.destroy()
            }
            if (track.inStream) {
                track.inStream.destroy()
                track.inStream = null
            }
            const outStream = track.outStream = mp4.encode()
            const fragment = this._generateFragment(i, time)
            if (!fragment) {
                return outStream.finalize()
            }

            if (startOffset === -1 || fragment.ranges[0].start < startOffset) {
                startOffset = fragment.ranges[0].start
            }

            const writeFragment = (frag) => {
                if (outStream.destroyed) return
                outStream.box(frag.moof, err => {
                    if (err) return this.emit('error', err)
                    if (outStream.destroyed) return
                    const slicedStream = track.inStream.slice(frag.ranges)
                    slicedStream.pipe(outStream.mediaData(frag.length, err => {
                        if (err) return this.emit('error', err)
                        if (outStream.destroyed) return
                        const nextFrag = this._generateFragment(i)
                        if (!nextFrag) {
                            return outStream.finalize()
                        }
                        writeFragment(nextFrag)
                    }))
                })
            }
            writeFragment(fragment)
        })

        if (startOffset >= 0) {
            const fileStream = this._fileStream = this._file.createReadStream({
                start: startOffset
            })

            this._tracks.forEach(track => {
                track.inStream = new RangeSliceStream(startOffset, {
                    // Allow up to a 10MB offset between audio and video,
                    // which should be fine for any reasonable interleaving
                    // interval and bitrate
                    highWaterMark: 10000000
                })
                fileStream.pipe(track.inStream)
            })
        }

        return this._tracks.map(track => {
            return track.outStream
        })
    }

    _findSampleBefore (trackInd, time) {
        const track = this._tracks[trackInd]
        const scaledTime = Math.floor(track.timeScale * time)
        let sample = bs(track.samples, scaledTime, (sample, t) => {
            const pts = sample.dts + sample.presentationOffset// - track.editShift
            return pts - t
        })
        if (sample === -1) {
            sample = 0
        } else if (sample < 0) {
            sample = -sample - 2
        }
        // sample is now the last sample with dts <= time
        // Find the preceeding sync sample
        while (!track.samples[sample].sync) {
            sample--
        }
        return sample
    }

    _generateFragment (track, time) {
        /*
            1. Find correct sample
            2. Process backward until sync sample found
            3. Process forward until next sync sample after MIN_FRAGMENT_DURATION found
            */
        const currTrack = this._tracks[track]
        let firstSample
        if (time !== undefined) {
            firstSample = this._findSampleBefore(track, time)
        } else {
            firstSample = currTrack.currSample
        }

        if (firstSample >= currTrack.samples.length) { return null }

        const startDts = currTrack.samples[firstSample].dts

        let totalLen = 0
        const ranges = []
        for (var currSample = firstSample; currSample < currTrack.samples.length; currSample++) {
            const sample = currTrack.samples[currSample]
            if (sample.sync && sample.dts - startDts >= currTrack.timeScale * MIN_FRAGMENT_DURATION) {
                break // This is a reasonable place to end the fragment
            }

            totalLen += sample.size
            const currRange = ranges.length - 1
            if (currRange < 0 || ranges[currRange].end !== sample.offset) {
                // Push a new range
                ranges.push({
                    start: sample.offset,
                    end: sample.offset + sample.size
                })
            } else {
                ranges[currRange].end += sample.size
            }
        }

        currTrack.currSample = currSample

        return {
            moof: this._generateMoof(track, firstSample, currSample),
            ranges,
            length: totalLen
        }
    }

    _generateMoof (track, firstSample, lastSample) {
        const currTrack = this._tracks[track]

        const entries = []
        let trunVersion = 0
        for (let j = firstSample; j < lastSample; j++) {
            const currSample = currTrack.samples[j]
            if (currSample.presentationOffset < 0) { trunVersion = 1 }
            entries.push({
                sampleDuration: currSample.duration,
                sampleSize: currSample.size,
                sampleFlags: currSample.sync ? 0x2000000 : 0x1010000,
                sampleCompositionTimeOffset: currSample.presentationOffset
            })
        }

        const moof = {
            type: 'moof',
            mfhd: {
                sequenceNumber: currTrack.fragmentSequence++
            },
            trafs: [{
                tfhd: {
                    flags: 0x20000, // default-base-is-moof
                    trackId: currTrack.trackId
                },
                tfdt: {
                    baseMediaDecodeTime: currTrack.samples[firstSample].dts
                },
                trun: {
                    flags: 0xf01,
                    dataOffset: 8, // The moof size has to be added to this later as well
                    entries,
                    version: trunVersion
                }
            }]
        }

        // Update the offset
        moof.trafs[0].trun.dataOffset += Box.encodingLength(moof)

        return moof
    }
}

module.exports = MP4Remuxer
