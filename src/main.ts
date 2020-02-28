import { Server, Client, PacketWriter, State } from "mcproto"
import { re } from "mcre"
import * as fs from "fs"
import * as zlib from "zlib"
import { updateProfile, Profile } from "./profile"

require("dotenv").config()

let proxy: ReturnType<typeof re> | null = null
let client: Client | null = null
let exited = false

if (!fs.existsSync("dumps")) fs.mkdirSync("dumps")

async function main() {
    let profile: Profile | null = null
    try { profile = JSON.parse(fs.readFileSync(".profile.json", "utf-8")) } catch { }

    while (true) {
        try {
            profile = await updateProfile(profile, process.env.MOJANG_USER, process.env.MOJANG_PASS)
            fs.writeFileSync(".profile.json", JSON.stringify(profile))
        } catch (error) {
            console.log(error)
            await new Promise(resolve => setTimeout(resolve, 10000))
            continue
        }

        if (exited) return

        try {
            client = new Client({
                profile: profile.id,
                accessToken: profile.accessToken,
                timeout: 36000
            })

            await client.connect("2b2t.org", 25565)

            console.log("connected")

            client.send(new PacketWriter(0x0).writeVarInt(340)
                .writeString("2b2t.org").writeUInt16(25565)
                .writeVarInt(State.Login))

            client.send(new PacketWriter(0x0).writeString(profile.name))

            // wait for login success packet
            let packet = await client.nextPacket(0x2, false)

            const uuid = packet.readString(), username = packet.readString()

            console.log("logged in")

            // player position and look
            client.onPacket(0x2f, packet => {
                packet.offset += 3 * 8 + 2 * 4 + 1
                const teleportId = packet.readVarInt()
                client!.send(new PacketWriter(0x0).writeVarInt(teleportId))
            })

            proxy = re(client, uuid, username)
        } catch (error) {
            console.log(error)
            // wait 10 seconds failed connection
            await new Promise(resolve => setTimeout(resolve, 10000))
            continue
        }

        const file = fs.createWriteStream(`dumps/${~~(Date.now() / 1000)}.dump.gz`)
        const gzip = zlib.createGzip({ level: 4 })
        gzip.pipe(file, { end: true })

        client.on("packet", packet => {
            const buffer = Buffer.alloc(packet.buffer.length + 12)
            buffer.writeUInt32BE(packet.buffer.length + 8, 0)
            buffer.writeDoubleBE(Date.now(), 4)
            packet.buffer.copy(buffer, 12)
            gzip.write(buffer)
        })

        let interval = setInterval(() => gzip.flush(), 10000)

        await new Promise(resolve => client!.on("end", resolve))

        clearInterval(interval)
        gzip.end()
        profile = null

        // wait two seconds after disconnect
        await new Promise(resolve => setTimeout(resolve, 2000))
    }
}

new Server(async conn => {
    await conn.nextPacket(0x0)

    if (conn.state == State.Status) {
        conn.onPacket(0x0, () => conn.send(new PacketWriter(0x0).writeJSON({
            version: { name: "1.12.2", protocol: 340 },
            players: { online: -1, max: -1 },
            description: { text: "2b2t bot" }
        })))
        conn.onPacket(0x1, packet => conn.send(new PacketWriter(0x1).writeInt64(packet.readInt64())))
        return
    }

    const username = (await conn.nextPacket(0x0)).readString()
    await conn.encrypt(username, true)
    conn.setCompression(256)

    if (proxy) {
        proxy.connect(conn)
    } else {
        conn.end(new PacketWriter(0x0).writeJSON({ text: "bot is not connected" }))
    }
}).listen(+process.env.PROXY_PORT!)

function onExit() {
    if (exited) return
    if (client) client.end()
    console.log("exiting")
    exited = true
    setTimeout(() => process.exit(), 2000)
}

process.on("SIGINT", onExit)
process.on("SIGTERM", onExit)

main()