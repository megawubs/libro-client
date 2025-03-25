import DownloadCLient from "@/lib/DownloadClient";
import InputHandler from "@/lib/InputHandler";
import APIHandler from "@/APIHandler";
import logger, {LogMethod} from "@/lib/Logger";
import Config from "@/lib/Config";
import State from "@/lib/State";

const scope = "LibroFmClient";

/** Client for the Libro.fm API. */
export default class LibroFmClient {
    config = new Config();
    state = new State();

    /**
     * Initialize the client.
     * Requests credentials if not provided in the config.
     * */
    @LogMethod({scope, message: "Initializing client..."})
    async init() {
        if (!this.config.authToken) {
            if (!this.config.username || !this.config.password) {
                const credentials = await InputHandler.requestCredentials();
                this.config.change(credentials);

                if (!this.config.username || !this.config.password) {
                    throw new Error("Username or password not provided");
                }
            }
            await this.login(this.config.username, this.config.password);
        }
        if (!this.config.downloadDir) {
            const downloadDir = await InputHandler.requestDownloadLocation();
            this.config.change({downloadDir});

            if (!this.config.downloadDir) {
                throw new Error("Download directory not provided");
            }
        }
    }

    /** Logs in to the Libro.fm API and saves the authToken in the config. */
    @LogMethod({scope, message: "Logging in..."})
    async login(username: string, password: string) {
        const data = await APIHandler.fetchLoginData(username, password);
        logger.verbose("Got new authToken", {fn: "LibroFmClient.login"});
        this.config.change({authToken: data.access_token});
    }

    /** Fetches the library of audiobooks. */
    @LogMethod({scope, message: "Fetching library..."})
    async getLibrary(): Promise<AudiobookMap> {
        if (!this.config.authToken) throw new Error("Not logged in");
        let audiobooks: AudiobookMap = {};
        let page = 1;
        while (true) {
            try {
                const data = await APIHandler.fetchLibrary(
                    this.config.authToken,
                    page
                );

                for (const book of data.audiobooks) {
                    audiobooks[book.isbn] = book;
                }

                if (page >= data.total_pages) {
                    break;
                }
                page += 1;
            } catch (error: any) {
                logger.error(`Failed to fetch library: ${error.message}`, {
                    fn: "LibroFmClient.getLibrary",
                });
                this.config.change({authToken: undefined});
                break;
            }
        }

        return audiobooks;
    }

    /** Downloads a list of books. */
    @LogMethod({scope, message: "Downloading books..."})
    async downloadBook(
        book: Audiobook,
        overwrite: boolean = false,
        keepZip: boolean = false
    ): Promise<string> {
        if (!this.config.authToken) throw new Error("Not logged in");
        const authToken = this.config.authToken;

        // fetch download links
        const metadata = await this.getDownloadMetadata(book.isbn);

        logger.verbose(`Downloading book: ${metadata.isbn}`, {
            fn: "LibroFmClient.downloadBook",
        });
        const urls = metadata.parts.map((p) => p.url);

        // check if book is already downloaded
        if (!overwrite && this.state.hasBook(book.isbn)) {
            const shouldOverwrite = await InputHandler.requestOverwrite(book);
            if (!shouldOverwrite) {
                logger.verbose("Skipping download", {
                    fn: "LibroFmClient.downloadBook",
                });
                return "";
            }
        }

        try {
            if (!book.authors) throw new Error("No authors found");
            const authors =
                typeof book.authors === "string"
                    ? book.authors
                    : book.authors.join(", ");


            const series = typeof book.series === "string"
                ? book.series
                : null

            const title = [book.series_num, book.title].filter(Boolean).join(' - ');

            const filename = [authors, series, title].filter(Boolean).join('/');

            const [path, zipped_files] = await DownloadCLient.downloadFiles(
                filename,
                urls,
                authToken,
                keepZip,
                this.config.downloadDir
            );

            await DownloadCLient.saveMetadata(book, metadata, path);

            this.state.addBook({
                book,
                path,
                meta: metadata,
                ...(zipped_files && {zippedPaths: zipped_files}),
            });

            return filename;
        } catch (error) {
            logger.error({error, fn: "LibroFmClient.downloadBook"});
            throw new Error("Failed to download books");
        }
    }

    /** Get list of books in library that are not downloaded */
    @LogMethod({scope, message: "Checking for new books..."})
    async getNewBooks(): Promise<Audiobook[]> {
        const library = await this.getLibrary();
        const newBooks = this.state.findDiff(library);
        return newBooks;
    }

    /** Fetches the download URLs for a specific book. */
    @LogMethod({scope})
    private async getDownloadMetadata(isbn: string): Promise<DownloadMetadata> {
        if (!this.config.authToken) throw new Error("Not logged in");
        const data = await APIHandler.fetchDownloadMetadata(
            this.config.authToken,
            isbn
        );
        return data;
    }
}
