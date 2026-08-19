---
jupyter:
  jupytext:
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  kernelspec:
    display_name: Python [conda env:.conda-cogweb]
    language: python
    name: conda-env-.conda-cogweb-py
---

<!-- #raw raw_mimetype="text/restructuredtext" -->
.. meta::
   :description: Topic: Computer Vision, Category: Discussion
   :keywords: supervised learning, gradient descent
<!-- #endraw -->

# Moving Towards Deep Learning

We just used gradient descent to fit a linear model against $2D$ data (wingspan vs height). 
While it may seem like we are a million miles away from deep learning (whatever that means; surely it must be much more impressive than linear regression), we have actually made contact with some of the essential concepts that are needed to understand deep learning.
By simply trading in our linear model for a much more generic one, we will quickly find ourselves in the act of "training" a "deep neural network" using "supervised learning".
In order to get our bearings, let's discuss three items here:


- What does the "learning" in "deep learning" mean, in practice?


 
## Is Linear Regression and Example of Machine Learning?

The colloquial use of the word "learning" is wrapped tightly in the human experience. 
To use it in the context of machine learning might make us think of a computer querying a digital library for new information, or perhaps of conducting simulated experiments to inform and test hypotheses.
Compared to these things, gradient descent hardly looks like it facilitates "learning" in machines.
Indeed, it is simply a rote algorithm for numerical optimization after all.
This is where we encounter a challenging issue with semantics; phrases like "machine learning" and "artificial intelligence" are not necessarily well-defined, and the way that they are used in the parlance among present-day researchers and practitioners may not jive with the intuition that science fiction authors created for us.

There is plenty to discuss here, but let's at least appreciate the ways that we can, in good faith, view gradient descent as a means of learning.
The context laid out in the preceding sections describes a way for a machine to "locate" model parameter values that minimize a loss function that depends on some observed data, thereby maximizing the quality of predictions that the model makes about said data in an automated way.
In this way the model's parameter values are being informed by this observed data.
Insofar as these observations augment the model's ability to make reliable predictions or decisions about new data, we can sensibly say that the model has "learned" from the data.

Despite this tidy explanation, plenty of people would squint incredulously at the suggestion that linear regression, driven by gradient descent, is an example of machine learning.
After all, the humans were the ones responsible for curating the data, analyzing it, deciding that the model should take on a linear form, *and* that the gradient-descent algorithm is to be used to modify the parameters of that linear model.
Fair enough; it might be a stretch to deem this "machine learning".
But we will soon see that merely swapping out our linear model for a much more flexible (or "universal") mathematical model will change this perception greatly.
This will occur when we set out to use machine learning to tackle much more diverse and ambitious problems.


## The Modeling Problem

Let's reflect on some typical problems that we might be interested in tackling via machine learning, and see how these can all be viewed through a unified framework.


<div style="text-align: center">
<p>
<img src="../_images/ml_task_overview.png" alt="Example machine learning tasks" width="500">
</p>
</div>

Displayed here are a diverse range of tasks that span an equally varied set of disciplines.

- Image classification (computer vision)
- Text comprehension (natural language processing / reasoning)
- Game strategization  (game artificial intelligence)
- Data extrapolation / phenomenological modeling (scientific computing)  

The common framework that undergirds each of these tasks is that a mathematical model will be used mediate the transformations of observations into the corresponding desired predictions or decisions.
Furthermore, from a machine learning perspective, we want to devise these models in such a way that they are capable of improving the quality of their predictions (or decisions) based on data that we provide them with; that is, we want them to able to learn.
It should be noted that a "mathematical model" need not merely be a single mathematical equation; it refers more broadly to a computer program that orchestrates a collection of mathematical equations and processes to transform the observed data.

Regardless of the fact that we hope to tackle these tasks using this common framework, the essential details of _how_ we solve these respective problems seems to be quite different from one another.
Traditionally, attempting to solve any of the above problems would require one to develop specialized knowledge in that subfield.

To develop a model that can classify pictures of cats versus dogs, for instance, would lead us down the path of learning about standard computer vision methods for measuring visual features – groups of edges, "blobs", and the like – within an image; we would then craft a model designed to extract and compose these features, and then give it the capacity to learn how these manifest differently among pictures of cats and dogs, respectively.
To provide some intuition about this, the image following depicts detected edges from a picture of a meerkat.


<div style="text-align: center">
<p>
<img src="../_images/meerkat_edges.png" alt="Example machine learning tasks" width="550">
</p>
</div>


Despite all of this hard work, we would have to start back at square one in our modeling process were we to later switch problem spaces to text comprehension (which is not to say that we wouldn't have gained valuable exp


## Scratch

A **neural network** ultimately serves the same role as our linear model: it acts as a mathematical function that maps some observed data to desirable predictions or decisions.
But, unlike a linear model, a neural network can have an incredible "capacity" for taking on the shapes of complicated patterns, which are useful for describing the intricate relationships between the inputs and outputs of our machine learning system.
And, quite remarkably, a neural network can be used to great effect *without our knowing what shapes it will take on*. 
This, again, leaves us far afield from our linear modeling experience, where we selected our mathematical model with an explicit and complete understanding of the patterns that it is capable of describing.
In this way, it is useful to think of a neural network as a formless block of clay.

<!-- #raw raw_mimetype="text/html" -->
<div style="text-align: center">
<p>
<img src="../_images/block_of_clay.png" alt="A diagram describing gradient descent" width="600">
</p>
</div>
<!-- #endraw -->

We will use gradient descent as we did for the linear model;
however, instead of merely tweaking the position and alignment of a line, gradient descent will play the role of "sculpting" our neural network so that it will capture intricate and even unknown patterns between our observed data and desired predictions.
In this way, because we did not know beforehand what "form" we wanted our mathematical model to take, the process of gradient descent takes on a distinct quality: it enabled the computer to discover the important rules or patterns that underpin our data.
For a machine to derive reliable and previously-unknown rules from data, which then enables it to make accurate predictions in the future about new observations, is quite incredible. 
This certainly counts as "machine learning" for most people in technical fields.

Neural networks will be introduced in detail shortly, but it is worthwhile for us to have considered them in such vague terms in order to appreciate the point made above. 
It is worth restating this: one can go from "performing a regression" to "enabling machine learning" by holding the actual "learning" algorithm (e.g. gradient descent) fixed and changing only the form of the mathematical model being used.
