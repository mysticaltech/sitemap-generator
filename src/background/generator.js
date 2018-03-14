import CenteredPopup from './centeredPopup';
import GeneratorUtils from './generatorUtils';
import WebRequestListener from './webRequests';

let url,
    requestDomain,
    initialCrawlCompleted,
    onCompleteCallback,
    contenttypePatterns,
    excludeExtension,
    successCodes,
    maxTabCount,
    terminating,
    targetRenderer,
    progressInterval,
    requestListener,
    lists;

/**
 * @class
 * @description This module crawls some website and generates a sitemap
 * for it. The process works as follows:
 *
 * 1. on start the generator will create a rendering window and
 * open a tab for the start url; then wait for http headers response.
 * 2. If received headers indicate success, generator will load a
 * crawling script in the tab that will scan the page looking for a-tag urls.
 * 3. The content script will send a message back to the generator with a
 * list of urls found on the page.
 * the generator will add all new urls to the queue and close the tab
 * 4. After the initial url has been processed new tabs will open on a
 * set interval to account for possible
 * errors and non-response until all urls in the processing queue have been checked
 * 5. After everything has been cheked the generator will close the window and provide
 * the results to the end user
 *
 * @param {Object} config - configuration options
 * @param {string} config.url - the website/app path we want to crawl
 * -- all sitemap entries will be such that they include this base url
 * @param {String} config.requestDomain - Chrome url match pattern for above url
 * @see {@link https://developer.chrome.com/apps/match_patterns|Match Patterns}
 * @param {Array<string>} config.contenttypePatterns - http response content
 * types we want to include in the sitemap
 * @param {Array<string>} config.excludeExtension - file extensions which should
 * be automatically excluded, example: `['.png','.zip']`
 * @param {Array<number>} config.successCodes - http response status codes which
 * should be regarded as successful
 * @param {number} config.maxTabCount - max number of tabs allowed to be open any
 * given time
 * @param {function} config.callback - *(optional)* function to call when sitemap
 * generation has completed
 */
class Generator {

    constructor(config) {
        url = config.url;
        requestDomain = config.requestDomain;
        onCompleteCallback = config.callback;
        contenttypePatterns = config.contenttypePatterns || [];
        excludeExtension = config.excludeExtension || [];
        successCodes = config.successCodes || [];
        maxTabCount = Math.max(1, config.maxTabCount);
        terminating = false;
        progressInterval = null;
        lists = {
            processQueue: [],
            completedUrls: [],
            errorHeaders: [],
            successUrls: []
        };
        this.generatorApi = this.generatorApi.bind(this);
        this.onComplete = this.onComplete.bind(this);
        this.navigateToNext = this.navigateToNext.bind(this);
        this.processDiscoveredUrls = this.processDiscoveredUrls.bind(this);
    }

    /**
     * @description Initiates crawling of some website
     */
    start() {
        const launchPage = window.chrome.extension.getURL('process.html');

        CenteredPopup.open(800, 800, launchPage, 'normal')
            .then((window) => {
                targetRenderer = window.id;
                // 1. add the first url to processing queue
                GeneratorUtils.listAdd(url, lists.processQueue);
                // 2. register webRequest listener where we listen to successful http request events;
                requestListener = new WebRequestListener(
                    requestDomain,
                    successCodes,
                    contenttypePatterns,
                    {
                        onMessage: this.generatorApi,
                        onNext: this.navigateToNext,
                        onUrls: this.processDiscoveredUrls,
                        onTerminate: this.onComplete,
                        onError: Generator.onUrlError,
                        onSuccess: Generator.onUrlSuccess
                    });
                // 3. navigate to first url
                this.navigateToNext();
                // 4. start interval that progressively works through the queue
                progressInterval = setInterval(this.navigateToNext, 500);
            });
    }

    /**
     * @description Listen to messages from the browser tabs
     * @see {@link https://developer.chrome.com/apps/runtime#event-onMessage|onMessage event}.
     * @param request - message parameters
     * @param request.terminate - stops generator
     * @param request.status - gets current processing status
     * @param request.urls - receive list of urls from crawler
     * @param request.noindex - tells generator not to index some url, see
     * @param {Object} sender -  message sender
     * @param {function?} sendResponse - callback function
     */
    generatorApi(request, sender, sendResponse) {
        if (request.terminate) {
            this.onComplete();
        } else if (request.noindex) {
            Generator.excludeFromIndex(request.noindex);
        } else if (request.urls) {
            this.urlMessageReceived(request.urls, sender);
        } else if (request.status) {
            return sendResponse(Generator.status());
        } else if (request.crawlUrl) {
            return sendResponse(url);
        }
        return false;
    }

    /**
     * @description Get stats about ongoing processing status
     */
    static status() {
        return {
            url: url,
            queue: lists.processQueue.length,
            completed: lists.completedUrls.length,
            success: lists.successUrls.length,
            error: lists.errorHeaders.length
        };
    }

    /**
     * @description Exclude discovered url from sitemap
     * @param {String} url - the url that should not be included in the sitemap
     */
    static excludeFromIndex(url) {
        url = encodeURI(url);
        GeneratorUtils.listAdd(url, lists.completedUrls);

        let successIndex = lists.successUrls.indexOf(url);

        if (successIndex >= 0) {
            lists.successUrls.splice(successIndex);
        }
    }

    /**
     * @description handler when http request returns successful status code
     * @param {String} url - the url that succeeded
     */
    static onUrlSuccess(url) {
        GeneratorUtils.listAdd(url, lists.successUrls);
    }

    /**
     * @description handler when http request returns error status code
     * @param {String} url - the url that succeeded
     */
    static onUrlError(url) {
        GeneratorUtils.listAdd(url, lists.errorHeaders);
    }

    /**
     * @description When process completes, generate the sitemap file
     */
    static makeSitemap() {
        return GeneratorUtils.makeSitemap(url, lists.successUrls);
    }

    /**
     * @description When url message is received, process urls,
     * then close tab that sent the message
     */
    urlMessageReceived(urls, sender) {
        this.processDiscoveredUrls(urls);
        if (sender && sender.tab) {
            window.chrome.tabs.remove(sender.tab.id);
        }
        initialCrawlCompleted = true;
    }

    /**
     * @description this method will kill any ongoing
     * generator and/or wrap up when processing is done
     */
    onComplete() {
        if (terminating) {
            return;
        }
        terminating = true;
        clearInterval(progressInterval);

        (function closeRenderer() {
            GeneratorUtils.getExistingTabs(targetRenderer, requestDomain,
                (result) => {
                    if (result.length) {
                        GeneratorUtils.closeTabs(result);
                        setTimeout(closeRenderer, 250);
                    } else {
                        requestListener.destroy();
                        onCompleteCallback();
                        window.chrome.windows.remove(
                            targetRenderer, Generator.makeSitemap);
                    }
                });
        }());
    }

    /**
     * @description take first queued url and create new tab for that url
     */
    navigateToNext() {
        if (!terminating) {
            let _then = (tabs) => Generator
                .nextAction(tabs, () => this.onComplete);

            GeneratorUtils.getExistingTabs(targetRenderer,
                requestDomain, _then);
        }
    }

    /**
     * @description Determine if it is time to launch new tab, terminate, or wait
     * @param {Array<Object>} tabs - list of currently open tabs
     * @param {function} done - callback if tab launch fails
     */
    static nextAction(tabs, done) {
        let openTabs = (tabs || []).length,
            emptyQueue = !lists.processQueue.length;

        if (!openTabs && emptyQueue && initialCrawlCompleted) {
            done();
        }
        if (openTabs > maxTabCount || emptyQueue) {
            return;
        }

        let nextUrl = lists.processQueue.shift();

        if (lists.completedUrls.indexOf(nextUrl) < 0) {
            GeneratorUtils.listAdd(nextUrl, lists.completedUrls);
            GeneratorUtils.launchTab(targetRenderer, nextUrl, done);
        }
    }

    /**
     * @description when urls are discovered through some means, this function determines
     * how they should be handled
     * @param {Array<String>} urls - the urls to process
     */
    processDiscoveredUrls(urls) {
        (urls || []).map((u) => {

            // make sure all urls are encoded
            u = encodeURI(u);

            // if there is successful entry for hashbang path
            // automatically record save result for the hashbang path
            if (u.indexOf('#!') > 0) {
                let page = u.substr(0, u.indexOf('#!')),
                    success = lists.successUrls.indexOf(page) > -1,
                    error = lists.errorHeaders.indexOf(page) > -1;

                if (success || error) {
                    GeneratorUtils.listAdd(u, lists.completedUrls);
                    if (success) {
                        GeneratorUtils.listAdd(u, lists.successUrls);
                    }
                    if (error) {
                        GeneratorUtils.listAdd(u, lists.errorHeaders);
                    }
                }
            } else if (u.indexOf('#') > 0) {
                u = u.substr(0, u.indexOf('#'));
            }
            return u;

        }).filter(function (u) {

            // filter for everything that is clearly not html or text
            let badFileExtension = false,
                test = u.replace(url, '');

            if (test.indexOf('/') > -1) {
                let parts = test.split('/'),
                    last = parts[parts.length - 1];

                if (last.length) {
                    badFileExtension = excludeExtension.filter(function (f) {
                        return (last.indexOf(f) > 0);
                    }).length > 0;
                }
            }
            // filter down to new urls in target domain
            return u.indexOf(url) === 0 &&
                (lists.completedUrls.indexOf(u) < 0) &&
                (lists.processQueue.indexOf(u) < 0) &&
                !badFileExtension;

        }).map(function (u) {
            // if url makes it this far add it to queue
            GeneratorUtils.listAdd(u, lists.processQueue);
        });
    }
}

export default Generator;
